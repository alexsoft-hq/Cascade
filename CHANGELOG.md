# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [semantic](https://semver.org/), and pre-1.0, which means the minor
number carries a change that would be a major one after 1.0. Published as
[`@alexsoft-hq/cascade`](https://www.npmjs.com/package/@alexsoft-hq/cascade).

Each dated section below is one round of work. The round protocol is in
[CONTRIBUTING.md](CONTRIBUTING.md#how-a-change-gets-in-the-round).

## [Unreleased]

## [0.8.1] - 2026-09-10

The rest of the Korean stack: one vendor's mapper XML, iBATIS 2, Nexacro
forms, and Next.js file routing.

The rest of the Korean stack. RM55 fixed what a route reaches on eGovFrame and
left four things in the open; this takes them. One vendor's mapper XML instead
of seven, iBATIS 2 read as SQL, a Nexacro client read as screens, and Next.js
file routing.

### Added

- **One mapper, shipped once per vendor.** The schema was not the only thing an
  eGovFrame project ships seven times. `EgovProgrmManage_SQL_{altibase,cubrid,
  hsql,mysql,oracle,postgres,tibero}.xml` are seven files with one `<mapper
  namespace="progrmManageDAO">` between them, so the SQL a statement ends up with
  is whichever copy the walk read last — and that copy is then parsed under the
  ONE dialect the run chose. `cascade init` groups them the way it already groups
  the DDL: two files are one mapper's copies when they declare the SAME NAMESPACE
  and their paths are the SAME PATH apart from a vendor's name. The copy for the
  vendor `catalog.ddl` chose is read; the rest go into a new profile key
  `mappers.alternatives`, and the statement lane reads past them by name. A set
  with no copy for that vendor keeps the first by sorted path and says so
  (`MAPPER_VENDOR_UNMATCHED`). Measured on the enterprise business template: 189
  mapper files to 27, and **47 statements failing to parse to 1**.
- **iBATIS 2 is read as SQL.** `<sqlMap namespace="…">` is the element that
  shipped before MyBatis was called MyBatis, and every eGovFrame project written
  before 3.x runs on it. One worker reads both elements and one framework pack
  declares the lane for either: the six statement tags (`select`, `insert`,
  `update`, `delete`, `procedure`, `statement`), `#name#` as a bind parameter and
  `$name$` as a raw substitution exactly as `#{}`/`${}` are treated, and the
  dynamic tags flattened by the rules `<if>`/`<where>`/`<foreach>` already
  follow — `<dynamic prepend>` folding its prepend in and dropping the first
  conjunction under it, `<iterate>` its open and close once, `<include refid>`
  resolved in the same fragment index. What a statement is CALLED comes from the
  configuration: `<sqlMapConfig><settings useStatementNamespaces="true"/>` makes
  the key `namespace.id`, and iBATIS' own default makes it the bare `id`, global
  across every sqlMap file. Two configurations that disagree are reported and the
  default stands; two files declaring one id is a named warning.
- **The Java side of the same shape.** `SqlMapClient`, `SqlMapClientTemplate`,
  `SqlMapClientDaoSupport` and `EgovAbstractDAO` join the session types the
  `mybatis-statement-id` rule accepts, and so does any base whose name ends in
  `IbatisAbstractDAO` — by suffix, because a framework vendor writes its own base
  on top of one of those and ships it in a jar, and naming the vendor would be a
  rule that works on one product. `queryForList`, `queryForObject` and
  `queryForMap` join the method list. A BARE id (`list("selectUserVOList", vo)`)
  is a weaker witness than `Namespace.id`, so it rides in its own field and binds
  only against a statement this pack holds under exactly that key; a bare word
  never finds a namespaced statement by looking like the end of it.
- **A Nexacro client is a frontend.** A very large share of Korean public sector
  and enterprise systems has one, and this lane read none of it. A directory of
  `.xfdl` forms is now a web root of kind `nexacro`, and under it the lane reads
  `.xfdl` and `.xjs` and nothing else — the vendor runtime shipped beside them is
  somebody else's frontend. One form is one screen: its `<Form id>`, its
  `titletext`, and its path under the client. Its `<Script>` CDATA is read as
  JavaScript (with the TypeScript grammar, because xscript5 annotates parameter
  types), its handlers on `this` are functions, and it renders its own script
  EXACT plus the `.xjs` it includes one hop out, SOUND_SET. Every request goes
  through one framework call, so `transaction(…)` is the rule: the native second
  argument, or the options object's `sController`/`svcUrl`/`strSvcUrl`/
  `sSvcUrl`/`sUrl`/`url`, resolved in the handler that holds it. A `prefix::path`
  url resolves the prefix through the application typedef's own `<Service
  prefixid url>` list. Rule `nexacro-transaction`, method `ANY`, graded by the
  route match; a url this lane cannot read is counted rather than dropped.
  Measured on `nexacro-spring/nexacro-sample-egov`: 30 screens where there were
  none, all 7 transactions matched to a `.do` route, 4 screens reaching a table.
- **Next.js routes by its file tree, and the lane reads the tree.** A new
  declaration-pack shape, `filesystem` (`adapters/web/packs/next-pages.json`),
  states the convention instead of a route object: `pages/index.tsx` answers `/`,
  `pages/content/[id].tsx` answers `/content/{id}`, `[...slug]` answers a
  catch-all, `_app`/`_document`/`_error`/`404`/`500` are the framework's own and
  `pages/api/**` are server handlers this frontend serves — counted and skipped,
  with a census line saying how many. The app router (`app/**/page.tsx`) is a
  second entry of the same shape. The rule fires only inside a package that
  depends on `next`. The page IS its own component, so RENDERS and its own calls
  work as they do for any router screen. Measured on
  `eGovFramework/egovframe-msa-edu`: 0 screens to 56 over two frontends, 9
  `pages/api` files read as handlers.

### Changed

- `cascade estimate`'s statements axis counts both elements and says how many of
  each. The screen axis is shipped when a run read Nexacro forms, the way it
  already is for route declarations and rendered pages.
- The overview's `screens.byKind` names `nexacro` only where there is one, so an
  answer about a product with no Nexacro screens is the answer it was.

### Fixed

- A statement whose namespace is empty is keyed by its bare id rather than by a
  key that starts with a dot.

## [0.8.0] - 2026-09-10

The release measured on the Korean market: eGovFrame, the public sector's
standard, joins the corpus held out, and the four things it showed are
fixed. A statement called by its id binds, a view resolver declared in
Spring XML makes pages, one vendor's schema is chosen by the configured
dialect, and a bean named by `@Resource` settles a dispatch.

### Added

- **A statement called by its string id binds.** MyBatis has two shapes and the
  lane read one. The other has no mapper interface at all: a DAO extends a
  session base and names the statement in the call,
  `selectList("CmmnDetailCodeManageDAO.selectCmmnDetailCodeList", vo)`. That is
  the whole persistence layer of eGovFrame, which every Korean public sector
  project is required to build on, and before this round
  `eGovFramework/egovframe-common-components` connected **1,193 routes to 1,256
  statements with zero edges between them**. The literal IS the key MyBatis looks
  the statement up by, and the mapper XML declares the same key as its namespace
  plus its id, so the edge is EXACT with `evidence.rule` `mybatis-statement-id`.
  The receiver has to be a MyBatis session, read by walking the `extends` chain by
  SIMPLE NAME for `SqlSession`, `SqlSessionTemplate`, `SqlSessionDaoSupport`,
  `EgovAbstractMapper` and `EgovComAbstractDAO` — by name, because that base ships
  in a jar no run parses, and the `extends` clause is the whole evidence. A
  literal naming no statement this pack holds gets no edge and is listed by name;
  a first argument no single file can read is counted with the expression as
  written. Measured: 1,238 of 1,290 call sites bind on the common components, 194
  of 246 on the enterprise template, and every miss is a component whose Java is
  shipped and whose SQL is not.
- **A view resolver declared as a Spring bean gives the template root.** A Spring
  MVC application written before Boot puts `prefix` and `suffix` in a `<bean
  class="…UrlBasedViewResolver" p:prefix="/WEB-INF/jsp/" p:suffix=".jsp"/>`
  rather than in `application.yml`. Discovery reads it, by the file's ROOT
  ELEMENT rather than by its name, so `dispatcher-servlet.xml`,
  `egov-com-servlet.xml` and `spring-mvc.xml` are one document. The `p:`
  shorthand and a `<property>` child read alike, and a commented-out bean is not
  a bean. Two eGovFrame repositories shipping 92 and 747 JSPs built 0 and 1
  screens because the root fell back to `src/main/webapp`; they now build 84 and
  657.
- **One vendor's DDL, chosen by what the project says it runs on.** A repository
  that has to run on seven databases ships its schema seven times, and reading
  all seven declared 182 tables eight times over on the common components, with
  13,505 duplicate-declaration warnings. Discovery now knows the vendor names the
  Korean market ships (`tibero`, `cubrid`, `altibase`, `goldilocks`, and
  `mariadb` as a vendor of its own rather than a spelling of MySQL), groups the
  DDL by vendor, and `cascade init` picks the one the tree NAMES: an existing
  `sqlDialects.main`, then a `Globals.DbType`-shaped property, then a jdbc url
  scheme every connection file agrees on. That vendor's files become
  `catalog.ddl` and the rest `catalog.ddlAlternatives`, both new profile keys.
  Nothing named, nothing chosen: the diagnostic lists the vendors and the profile
  is left alone. `sqlDialects.main` accepts `tibero`, `altibase` and
  `goldilocks` (parsed with the Oracle grammar they were built to be compatible
  with) and `cubrid` (MySQL), with the identifier rule failing closed on `exact`,
  because this engine has no citation for how any of the four folds a name.
- **`@Resource(name = "x")` settles a dispatch.** A field injected BY NAME whose
  declared type is an interface reached every implementor. When exactly one class
  in the pack answers to that bean name — its own `@Service("x")`, or the
  decapitalised name Spring would give it — the call site goes to that class:
  rule `spring-bean-name`, `candidateCount: 1`, the bean on the evidence. **The
  grade does not move** (I-1: an interface dispatch is never a proof), and an
  interface method that is a transaction boundary keeps its hop, because the
  transaction's footprint is walked forward from that member. On
  `nexacro-spring/nexacro-sample-egov` this REMOVED reach: four of its six routes
  claimed to run MyBatis statements their own annotation says they never touch,
  because one service interface has an iBATIS implementation and a MyBatis one.
- **Six Korean-market repositories joined the generality gate, HELD OUT.** The
  five eGovFrame projects, a Nexacro client over an eGovFrame backend, and
  `naver/ngrinder` as a control. They were measured BEFORE any of the rules above
  existed, and `docs/measured.md` keeps that first measurement beside the one
  after. The eleven repositories already in the corpus did not move by one
  number.

## [0.7.0] - 2026-09-10

The release where a JPA query is read the way Hibernate runs it, found by
the release before it: the real trace that scored 0.6.0's pack a failure
scores this one a pass.

### Fixed

- **A JPA query reads more tables than it names, and the lane now follows them.**
  RM53's real OpenTelemetry capture of spring-petclinic disagreed with the pack on
  six of the ten routes it observed. `OwnerRepository.findByLastNameStartingWith`
  was said to read `owners`; the run read `owners, pets, types, visits`, because
  `Owner.pets` is `@OneToMany(fetch = EAGER)`, `Pet.type` is a `@ManyToOne` (eager
  by the JPA default) and `Pet.visits` is eager too. `VetRepository.findAll` was
  said to read `vets`; the run read `vets, vet_specialties, specialties` through a
  `@ManyToMany(fetch = EAGER)` and its `@JoinTable`. Every statement whose result
  is an entity now carries that closure: each association whose effective fetch is
  EAGER, recursively, cycle-safe, capped at eight hops, with the target's table,
  its columns and any join table it crossed. The query's own plan overrides the
  mapping, so a `JOIN FETCH` and every `@EntityGraph` attribute path (written out,
  or named through the entity's `@NamedEntityGraph`) is followed whatever
  `fetch =` says. A LAZY association stays OUT and is counted, because a
  collection a page touches after the query has run is a real read this lane
  cannot see: the statement carries one sentence saying so and the lane reports
  the total. `delete` now follows `cascade = ALL/REMOVE` the way `save` already
  followed `ALL/PERSIST/MERGE`. Every one of those edges names its rule
  (`jpa-eager-fetch` with `explicit`/`default`, `jpql-join-fetch`,
  `jpa-entity-graph`, `jpa-cascade`) and the attribute path it came in on, so a
  table nobody expected can be traced back to the field that brought it.
- **A `@ModelAttribute` method is reachable from the handlers Spring runs it for.**
  `GET /owners/{ownerId}/edit` and `GET /owners/{ownerId}/pets/new` answered no
  table at all, because the owner is loaded by `OwnerController#findOwner`, a
  `@ModelAttribute("owner")` method the framework runs before every handler of
  that controller, and no line of source calls it, so no edge led to it. There is
  now a `MAY_CALL` from every handler of a `@Controller`/`@RestController` to
  every `@ModelAttribute` method the same class declares, rule
  `spring-model-attribute`, graded EXACT because nothing was resolved: the
  framework's own contract says the method runs. A `@ControllerAdvice`'s model
  attributes, ones a controller inherits, and handlers a controller inherits are
  NOT followed and are counted instead. A `@ModelAttribute` on a parameter is a
  binding, not a method Spring runs, and is never read as one.
- Measured, on the corpus: spring-petclinic goes from 9 of 17 endpoints reaching a
  statement to 15, from 4 tables to 7 and from 18 columns to 24; petclinic-ms from
  5 tables to 7 and 20 columns to 24. All six recall misses in the real capture
  close. The nine other pinned repositories do not move by one number.

### Changed

- The Java worker is `javafacts/10`: an entity attribute records `fetch` and
  `targetEntity`, an entity records the `@NamedEntityGraph` plans it declares, a
  repository method records its `@EntityGraph`, and a type records the methods it
  declares that carry `@ModelAttribute`. All of it is evidence as written, joined
  and decided in the bridges.

## [0.6.0] - 2026-09-10

The release where the running program does the certifying and the viewer
stops announcing what nobody has done yet. Also the refactoring of the
whole code base behind it: four rounds, no function over two hundred lines
left, a linter, a ratchet, and three recorded nets that hold every answer
byte for byte.

### Added

- **Golden cases proposed from an execution trace:** `cascade golden propose
  --from-otel <trace>` (repeatable; an OTLP/JSON document or the Java agent's own
  log, told apart by reading them). A proposal sampled from the pack is right by
  construction, so it carries no weight until a person reads it, and almost
  nobody ever does. This takes the labels from the one place the analyzer cannot
  reach: the program running. Every route the trace exercised becomes an
  `endpoint->tables` case carrying the tables of every statement that ran under
  that request, and every method that ran SQL becomes a `method->statements`
  case. Repeated observations of one input merge into one case (the union of the
  tables, with the counts and the time window on it). A route or a method this
  pack does not know stays out and is counted in one line, so nothing is
  invented, and the route matching is the runtime census's own rather than a
  second reading of the graph. The other two relations are questions no single
  run answers, and the command says so instead of shipping half a corpus.
  Execution proves REACH, so a runtime case carries no `absent` ids and scores
  recall alone: it can show the answer covered what ran, and it can never show
  precision. A human still stamps the approval, and for these `--all` is the
  expected path, because what they are agreeing to is that the recording is a
  fair one rather than that the analyzer was right.
  A route a run reached with no statement under it asserts NOTHING, and an empty
  assertion is scored one way only: `PASS` where the pack answers no table either
  (two independent sources, one reading the code and one running it, agreeing that
  this route reads nothing), and `UNSCORABLE` where the pack answers tables the
  run never touched, because the request may not have taken that branch and
  neither verdict follows. Counting those as passes is what would have let a run
  that touched no database at all certify one. `propose` says how many of the
  cases it wrote assert nothing, and `check` prints that count and the unscorable
  one per relation (`emptyCases`, `unscorable` in the summary).
- **A relation whose cases cover its whole population is scored as the census it
  is** (`population`, `exhaustive` in the golden summary). A Wilson bound says
  what a SAMPLE implies about the population it came from; when the corpus IS the
  population there is nothing left to infer, so every case right is `PASS` even
  below the 30-case floor, and one case wrong is `FAIL` however small the corpus.
  spring-petclinic has 17 endpoints, and under the floor alone its
  `endpoint->tables` row could never have been shown at all. COVERED MEANS
  SCORED: only the cases that came back PASS or FAIL count, so one left
  UNSCORABLE takes its input back out and the relation is a sample again. The
  flag is not believed on the way back in either: `src/core/trust.mjs` compares
  the counts again.
- **The `method->statements` population is every symbol that BINDS a statement**,
  read off the `IMPLEMENTS_STMT` edge instead of off the MyBatis lane's
  `mapperMethod` flag. A Spring Data repository method binds a statement and never
  carries that flag, so on a JPA project the pool was empty: the relation was
  never sampled, `propose` reported "0 candidates", and its population was zero,
  on exactly the projects where a runtime trace matters most. spring-petclinic
  goes from 0 to 6. This widens hand-sampling there too, which is the improvement:
  `golden propose` now offers those six methods for approval like any MyBatis
  mapper method. `src/core/overview.mjs` has counted mapper methods this way all
  along.
- **A trust level for what RAN: `RUNTIME_PASS`**, between `GOLDEN_FAIL` and
  `GOLDEN_PASS`. It says the gate passes, nothing FAILED, `endpoint->tables`
  PASSED, and at least one passing relation rests only on cases a trace labelled.
  What it claims is exactly what execution can show, which is why it is its own
  level: the answer covered what actually ran. It claims nothing about precision,
  and nothing about a route nobody exercised. A relation that could not be scored
  does not hold it down: it is named in `trust.gatesNotShown` as before, because
  "this was measured and passed" and "these were not measured" are two facts and
  demoting the first loses both. Three of the four relations sit in that state
  after a first trace and no amount of tracing moves them.

### Changed

- **The masthead trust chip is silent where it used to shout.** A project with no
  approved golden set now gets no chip at all: `not certified` was true of nearly
  every project anybody has ever opened, and nothing on the masthead let a reader
  do anything about it. The level still stands in the evidence rail beside every
  answer, and its hover there says what the level means plus the two things that
  move it (approve a golden set, or label the checks from a recording with
  `golden propose --from-otel`). A `RUNTIME_PASS` answer wears `checked against
  what ran` in amber, and its hover names the checks that were not scored and
  says that precision is not covered. The chip reads the engine's own REASON
  (`no-project-golden`) rather than the level's name: the page still holds no
  list of levels.

- **Internal surface: `duplicateFqnCensus` is no longer re-exported from
  `src/adapters/java_bridge.mjs`.** A stray `export` keyword had been exporting
  it by accident since before the Java lane was split; RM50 kept it reachable
  with a note rather than narrowing a surface on its own judgement, and this
  round removes it deliberately. It is still a proper export of
  `src/adapters/java/stats.mjs`, which is where the one test that uses it reads
  it from. Nothing outside this repository could have been importing it from the
  bridge, because the bridge is not a published entry point.

### Fixed

- **The Overview no longer prints the word `null` between two panels.** The hero
  column was filled with `replaceChildren(hubs, gaps, connected, grades)`, and the
  connected-projects panel is `null` on a project with no connected projects,
  which is most of them. A browser does not drop a null child: it converts every
  argument that is not a node with ToString, so the text `null` stood between
  "What we could not see" and "How sure the lines are" on nearly every project
  since RM45. Both places that did this now go through `setKids`, which drops the
  empty slots (the other was the source pane's footer, which printed `null` beside
  a grade that had no sentence with it). The test DOM stub used to skip a null
  child quietly, which is why no test ever saw either one; it stringifies now, the
  way the DOM does.
- **`cascade view --port 0` prints the port it actually got.** `serveHttp`
  resolved with the port it was ASKED for, so a run with `--port 0` (ask the
  kernel for a free one) printed `http://127.0.0.1:0/` and nobody could open it.
  It now resolves with `server.address().port`, and the `view` line prints that.
- **`cascade <command> --help` explains the command instead of running it.**
  It printed nothing: no branch read the flag, so it fell through to the command
  body and the command did its job. `cascade analyze --help` analyzed the
  directory you were standing in and wrote a pack into it, `cascade init --help`
  registered that directory, and `cascade catalog fetch --help` went looking for
  a database. Now the first thing the binary does, before a single other flag is
  read and before anything is resolved, discovered or written, is print that
  command's section of the usage text on stdout and exit 0 — `-h` too, and
  whatever else is on the line. `cascade`, `cascade --help` and `cascade help`
  still print the whole text on stderr and still exit 2, unchanged to the byte.

## [0.5.0] - 2026-09-09

The release where a server-rendered page is a screen: the pages a
`@Controller` renders, the routes that show them, the calls their own
scripts and forms make, and the tables all of that ends at.

The round where a server-rendered page is a screen. Three of the eleven corpus
projects had none, for one reason: they have no frontend router at all. A
`@Controller` returns a view name, a template engine renders it, and the page's
own `<form>`, its links and its inline `<script>` are what talk to the backend.

### Added

- **The Java worker records the page a handler renders** (`javafacts/9`). A
  method of a `@Controller` that is not a `@RestController` and carries no
  `@ResponseBody` emits a `view` record: the name from a returned literal, from
  every literal leaf of a returned ternary, from `new ModelAndView("x", …)`,
  from `mav.setViewName("x")`, from a `static final String` the same class
  declares (`from: constant`), or from a private method of that class whose
  every return is such a literal or such a field (`from: helper`, with the
  method's name). `redirect:` and `forward:` are the record's KIND rather than
  part of the name. All six are read out of ONE file, so all six are EXACT.
  Two guards: the helper is read one level deep, and two methods of one name are
  read as neither. Anything a returned name could ALSO mean — a field of a
  superclass, a method somebody overrides, a constant from another file, a local
  variable — is not resolved: it is counted in `unresolved`, so the run says how
  many pages it could not name instead of guessing one.
- **Discovery finds the template roots and the engine.** RM46's Spring config
  reader now also reads `spring.thymeleaf.*`, `spring.freemarker.*`,
  `spring.mvc.view.*` and `spring.velocity.*`, in every spelling Spring's
  relaxed binding accepts. A configured prefix picks out the directory it names
  (`classpath:/templates/` -> `src/main/resources/templates`); with nothing
  configured, the root is the directory every template of one resource root sits
  under, with the engine's documented suffix. `cascade init` writes
  `profile.templateRoots` and prints one line; `cascade analyze` prints the
  roots it will read; `cascade estimate` says how many pages and which engine.
  A list already in the profile is the user's, an empty one included.
- **The web worker reads a template** (`webfacts/5`). Four things per file, and
  nothing else: the inline `<script>` blocks, put through the SAME JavaScript
  reader every `.js` file goes through after the template's own directives have
  been neutralised into placeholders that keep every line where it was; the
  `<form>`s; the links that name a path from the app root, static assets left
  out by prefix and by extension; and the includes (`<%@ include%>`,
  `<jsp:include>`, `<#include>`, `<#import>`, `th:replace`/`insert`/`include`),
  resolved lexically so a shard still describes the bytes of its own file.
  Thymeleaf, FreeMarker, JSP, Velocity and plain HTML.
- **The context path is the app root.** `${request.contextPath}`,
  `${pageContext.request.contextPath}`, `@{/…}`, `<c:url>` and `<spring:url>`
  all name where the deployment is mounted, which is not part of any route the
  pack serves, so a page's prefix is the empty string and `prefix.from` is
  `context-path`. A page whose layout writes `var base_url =
  '${request.contextPath}'` and whose own script writes `base_url + "/x"` is
  read the same way: the worker records the NAME the URL was built on, and the
  bridge closes the hole with the include graph.
- **jQuery is a client the pack knows.** A page loads it with a `<script>` tag,
  so nothing imports it and nothing binds it: it is a platform sink for the same
  reason `fetch` is. `$.ajax({url, type})`, `$.ajax(url, settings)`,
  `$.post`, `$.get` and `$.getJSON` are call sites, in a `.js` file and in a
  page's inline script alike. `$('#x').val()` is not, and neither is `$.each`.
- **A page is a screen.** Every template a `view` record names becomes
  `screen:view:<view name>` carrying its `template`, its `engine` and the
  route(s) whose handler renders it; the `view:` prefix keeps a hybrid
  application's two kinds of screen apart. `symbol --RENDERS_PAGE--> screen` is
  EXACT, because the literal the handler returned is the resolver's own input.
  The page's inline scripts are its own functions (`RENDERS`, EXACT, rule
  `template-own`) and each template it includes is a candidate (`RENDERS`,
  SOUND_SET, rule `template-include`), followed four deep, with its calls
  counting for every page that includes it. A `redirect:` becomes
  `symbol --CALLS_HTTP--> endpoint`, graded by the route match like any call. A
  template no handler names is not a screen: it is counted and left alone.
- **The screen axis turns on for a server-rendered application**
  (`from: server-views`), beside the router cases, and `overview.screens.byKind`
  splits the screens into `router` and `page`. `browse kind=screen` and the
  screen card show the template and the routes; `flow` walking down from a route
  lists the page it shows.

### Changed

- **A directory named after somebody else's library is never a frontend root.**
  `adapters/web/packs/vendor-dirs.json` declares them (`plugins`, `libs`,
  `codemirror`, `layer`, `nprogress`, `adminlte`, …) and `src/core/discover.mjs`
  mirrors the list, with a test that fails if the two disagree. Measured:
  xxl-job went from 13 vendored web roots to 1 and jeecg-boot from 16 to 4, and
  both kept their own.

### Measured

The three projects that had no screens now have them, with nothing configured:
spring-petclinic 8, xxl-job 11, jpetstore-6 16, and two more projects gain pages
they never had a way to show: jeecg-boot 15, beside the 166 screens its Vue
frontend's router declares, and jeepay 5. Frontend calls resolved: jpetstore-6
0 -> 52 of 53, xxl-job 0 -> 24 of 31, spring-petclinic 0 -> 12 of 13, jeecg-boot
538 -> 562. Screens reaching a table: jpetstore-6 0 -> 16, xxl-job 0 -> 6,
spring-petclinic 0 -> 3, jeecg-boot 19 -> 25. jpetstore-6 is the first project
in the corpus whose `screen` axis reads `shipped`: every one of its 22 handler
returns is a name this engine can read, and every one of its 16 pages reaches a
table. No project moved down by one number, and every `endpointColumnPairs` is
exactly where it was — the gate baseline's five moved entries do not touch that
column at all.

`RENDERS_PAGE` is deliberately **not** in `FLOW_EDGE_TYPES`, and that is the one
measurement worth reading twice. A page's own form and links are the NEXT
request, not this one, and following them from the route that renders the page
made every route inherit the reach of every route its page links to: what one
endpoint reaches inflated by 81% on jpetstore-6 (243 -> 439 endpoint/column
pairs) and 14% on xxl-job, with no union count moving by one, which is exactly
the smear the fan-out ceiling exists to catch. The relation is a real edge and
is taken ONE step instead, in the two questions that ask it: `screen_impact`
turns "this method reads the column" into "this page shows it", and `flow`
walking down from a route lists the page without following it.

## [0.4.0] - 2026-09-09

The release where a screen in one service reaches a table in another with
nothing typed by hand: the service names and the gateway's route table are
read from the tree, a frontend shipped without a package is read anyway, and
an AngularJS app gets its screens.

### Added

- **The service name comes out of the tree.** `spring.application.name` is what
  tells two projects apart when both serve `GET /owners`, and until now nothing
  read it: the routes sidecar's `serviceNames` was always empty and a tie was
  settled by the project id or not at all. `cascade init` now reads it from
  every `application*.yml` / `bootstrap.yml` / `application.properties` under a
  non-test `resources` directory, writes `profile.serviceNames`, and prints
  `service name: <name> (from <file>)`. `cascade analyze` copies the names into
  `routes.json`, which is the file the federation matcher reads.
- **The gateway's route table comes out of the tree.** A Spring Cloud Gateway
  states which front-end prefix becomes which back-end prefix, and which
  deployable answers it, in its own `application.yml`; `profile.gatewayRoutes`
  was a map a person had to type. `cascade init` now reads
  `spring.cloud.gateway…routes` (the classic key path and the `server.webflux` /
  `server.webmvc` / `mvc` spellings, in YAML and in `.properties`), turns each
  route with a `Path=` predicate into one entry, and applies `StripPrefix`,
  `PrefixPath` and `RewritePath` to work out the back prefix. A rewrite outside
  the plain form Spring documents, a filter that sets the whole path, or a
  pattern with a wildcard in the middle produces a `GATEWAY_ROUTE_UNREADABLE`
  diagnostic and no entry, rather than a guess.
- **A gateway route can name the service it forwards to.** A `gatewayRoutes`
  value may now be `{ to, service, from }` as well as the plain back-prefix
  string it has always been. Both bridges read it through one reader
  (`gatewayRouteOf` in `src/core/profile.mjs`): the web bridge rewrites a
  frontend call that carries the prefix in its own path and puts `service` /
  `serviceLiteral` on the edge, and the Java bridge does the same for an
  imperative HTTP call that carried no host of its own. That name is what lets
  an answer cross into the right sibling when several serve the same path.
- **An unmatched outbound route says who it was for.** `overview.federation`'s
  `unmatchedRoutes` rows carry `service`, so "nobody here serves this" comes
  with the project to register.
- **A project analyzed before this round still answers to its name.** When
  `profile.serviceNames` is empty, `cascade analyze` stamps the sidecar with the
  names its own discovery read (it already walks the tree for its lanes) and
  says on the lane census that they are not in the profile yet, with the command
  that records them. A profile that declares names wins as before, and the pack
  and its digest are the same either way.
- **`cascade estimate` names both.** The report says the service name it found
  and where, and how many gateway routes the tree declares against how many the
  profile does.
- **A frontend with no `package.json` is read.** Plenty of products ship the
  screen side as `<script src>` tags under `src/main/resources/static/`, with no
  manifest anywhere. Nothing there declares a framework dependency, so the lane
  refused to open those files at all: the petclinic gateway's 22 of them, its
  nine screens and its thirteen `$http` calls were invisible, and so were
  jeepay's and xxl-job's. `cascade init` now calls a directory of frontend
  sources a **vendored web root** when the tree says it is served (it is, or is
  under, a `static` / `public` / `webapp` / `www` directory, or under
  `resources/templates`, or an `index.html` beside it loads one of its files),
  no `package.json` sits above it inside its own repository, and nothing on its
  path is somebody else's code. It writes them to a new profile key `webRoots`
  and prints one line naming the directory, the file count and the way to switch
  it off. `cascade analyze` reads that key beside the roots a `package.json`
  gives, and the census says which roots are vendored.
- **The router pack is chosen from the source when no dependency names it.**
  There is no dependency list for a vendored root, so discovery reads up to 400
  of its files and looks for the registrar spellings the packs name. What it
  finds goes into `frameworkPacks`, and `cascade estimate` says so on the `web`
  axis: `No dependency list names the framework there, so the router pack is
  chosen from the source alone (angular-router)`.
- **An AngularJS router pack, and the CHAIN shape it is written in.**
  `adapters/web/packs/angular-router.json` describes
  `$stateProvider.state(name, route).state(…)` and `$routeProvider.when(path,
  route)`: one route per link, recorded at its own line, with the state's `url`
  composed onto its parent's (the `parent` key, or the prefix of a dotted name),
  and an abstract state composing without being a screen. Its route objects are
  read only where its own registrar names them, so an options object with a
  `url` and a `component` anywhere else is still an options object.
- **Screens attach through the framework's own name registry.** A frontend
  written before modules imports nothing: `<owner-list>` in a state's template is
  a string AngularJS matches against a registry of names. The worker records
  each `angular.module(…).component / .controller / .directive` registration as
  a fact and reads the HTML template a registration points at for its custom
  element tags and nothing else; the bridge walks tag to component to controller
  to file. `RENDERS` is **EXACT** when every name in the chain matched exactly
  one registration, because the framework resolves by that exact string, and
  **HEURISTIC** when a name is registered twice, because which module loads last
  is not in the source. The chain of names is on the edge (`evidence.names`),
  and a name nothing registers gets no edge and is reported as
  `SCREEN_COMPONENT_UNREGISTERED`.
- **`$http` is a client, and the pack says so.** AngularJS hands its HTTP client
  to a function as a parameter, so nothing in the file binds it and every
  tracing rule saw a call on an unknown object. `http-clients.json` gains an
  `injected` list; a parameter is that client only when it is spelled like the
  pack's name **and** its function sits where the framework fills one in (a
  function passed to `.controller(…)` / `.service(…)` / `.factory(…)` /
  `.component({controller})`, or the inline `['$http', function ($http) {}]`
  array). The edge is SOUND_SET with `sink.kind: "injected"`. That is also the
  one place a relative path (`api/customer/owners`) counts as a URL.
- **`screen_impact` crosses into the project the screens are in.** A column
  question asked of a service whose product has no frontend of its own now names
  the screens a **sibling** shows it on, each row carrying `project`, the routes
  it came in on and `viaHttp`, exactly as `endpoint_impact` already returned the
  routes on the far side of the same crossing.
- **The route a request ENTERED is a row of the endpoint lane.** A crossing
  lands on a route in the other project and the walk over there starts at it, so
  nothing below drew it: `flow` down from a screen showed `0 / 0` endpoints
  beside a note about a connection this mode does not trust, for a request that
  plainly entered `GET /owners` next door. Each crossing's target route is now an
  `endpoints` row carrying `project`, `federated`, `viaHttp`, the crossing's
  grade and the hop it was entered at, walking down from a screen and from a
  route alike. It is not counted in this project's own endpoint census: `walk`
  and `layers` still describe this project's walk, as they already did for the
  tables.
- **The overview says the second number.** "0 of 9 screens reach a table, 9
  reach none" is true of one pack and false of the product: on a gateway whose
  every request is answered elsewhere, eight of those screens end at a real
  column one hop away. `overview.reach` gains `viaFederation: {screens,
  endpoints}` — this project's screens and routes that reach a table in a
  CONNECTED project, from one sibling walk per distinct crossed route — and the
  page says both under the dial (`0 here, 8 in connected projects`). The dial
  keeps this project's own ratio. Absent on a single-project server and when
  nothing this project calls lands on a table.

### Fixed

- **A route declaration is no longer read as an HTTP call.**
  `$stateProvider.state('owners', {url: '/owners'})` came out of the worker as a
  call to `/owners` and `$urlRouterProvider.otherwise('/welcome')` as a call to
  `/welcome`: on the petclinic gateway that was eight of the nine "calls with a
  URL" the lane reported, and since federation those false calls crossed into
  another service and told a real table that a screen touched it. Two
  declarations close it for every pack: an object argument any router pack reads
  as a route contributes no URL to a call, and a call a pack lists in
  `declarationCalls` sends nothing.

### Changed

- **Three keys are the user's the moment they exist.** `cascade init --force`
  reads the profile already on disk and leaves a non-empty `gatewayRoutes`,
  `serviceNames` or `webRoots` exactly as it is, saying what it found and did
  not apply. For `webRoots` an EMPTY list counts as an answer too: it is how a
  project says "read none of them".
- **A run says a thing once, however many roots it has.** `cascade init`'s
  "frontend without a package" line and the `WEB_ROOT_SAID_NOTHING` warning were
  one line per root, which is thirteen lines on a tree that keeps a directory of
  vendored plugin scripts. Both are one line now, naming the first five roots
  and then how many more; the counts stay exact. The `analyze` census line lists
  its roots the same way.
- **The web worker is `webfacts/4`.** It prints two new record kinds
  (`registration`, and the template facts that ride on a route or a
  registration), an `injected` marker on a call, and three new summary counters.
  Every web shard is re-read once, as a worker version change always does.
- **The YAML reader is one reader.** `src/core/dbconfig.mjs` grew
  `readYamlLeaves`, which the datasource reader is now a thin wrapper over and
  which the Spring configuration reader uses: one set of quoting, comment and
  document rules, with block and flow sequences added for the route table.
- **A `gatewayRoutes` map with no lane to read it is announced more precisely.**
  The Java lane has applied the map since 0.2.0, so the "nothing will read this"
  diagnostic now fires only when neither `web` nor `spring-mvc` is declared.


## [0.3.0] - 2026-09-09

The connected projects are in the pictures. 0.2.0 let a question walk from one
registered project into the next; 0.3.0 shows where a project's requests go on
the Overview, the Graph and the ERD, without merging packs and without drawing
a key between two services.

### Added

- **The whole-pack pictures follow a request into the next project.** `flow` and
  `endpoint_impact` already kept walking into a registered sibling; the three
  pictures did not, so on a five-service petclinic the api-gateway's Graph drew
  two dead-end routes and its ERD was empty, though its requests end at `owners`
  in customers-service and `visits` in visits-service. `map` now draws the
  sibling's own endpoint node as the portal, with one `calls` link from the
  endpoint that made the request and that route's own picture under it, and
  `erd` carries one `federated` cluster per project reached, with that project's
  own tables and its own joins between them. Every id from another pack is
  namespaced `<project>|<id>` and every node and link carries `project`.
  `overview.federation` gains `byProject` and `unmatchedRoutes`, so the page can
  list who answers what instead of re-deriving it.
- **Nothing is merged, and that is the rule the round is built on.** Only what
  this project's requests reach is added: jeecg alone is 10 601 nodes, and two
  services never share a foreign key, so a merged picture would be unreadable
  and a relationship line across two projects would be a lie. No relationship on
  an `erd` answer ever joins two projects; the only thing connecting the
  clusters is the HTTP call, which `via` names with its route and its grade.
- **One node cap and one byte budget for the whole picture.** `buildMap` takes
  the nodes another pack contributed and cuts them inside the same budget, first
  within their kind, and a cluster goes whole once the route it hangs off goes,
  because a table with no line to it says nothing. `limits` names what went and
  from which project. `buildMap` also takes `only`, which draws the picture of
  named endpoints alone, so crossing into a sibling costs one route's walk
  rather than that whole pack's.
- **The viewer draws all three.** The Overview lists the connected projects with
  their routes and one row for the calls nobody serves; the Graph rings a node
  that came from another pack in that project's own hue, seeds each cluster on
  its own band to the right, and offers one action on it, which is to open it
  where it lives; the ERD frames each project's cluster and runs a dashed line
  from the route marker to the tables it reaches, with the legend saying that a
  dash is an HTTP call and not a foreign key.

### Changed

- **A call that no route reaches is said out loud.** A picture drawn from routes
  cannot show a call made by a scheduled job, a startup listener or a tool an AI
  model calls, and on genai-service that is all four of its outbound calls. The
  map now names those methods and routes in `limits` instead of leaving the
  reader to read the silence as "this project calls nobody".
- **`federationHops: 0` says the cap, not "nobody serves it".** A call the
  crossing budget never let the answer ask about is no longer listed as
  unmatched: it gets its own sentence naming the cap and the way to raise it.
- `map` and `erd` accept `federate` and `federationHops` like `flow`. With
  `federate: false`, and on a server that serves one project and calls nobody,
  both answers are byte for byte what they were before this round: verified by
  diffing against a checkout of 0.2.0 on the registered mall pack.

## [0.2.0] - 2026-09-08

The release that follows a request across services: an imperative HTTP call
becomes an edge, a registered project's route answers another project's call,
and a trace of what really ran sits beside the grade. Everything below was
measured on the corpus in `docs/measured.md`.

### Added

- **One answer across several packs.** One repository per microservice is the
  normal shape, so each service analyzes into its own pack, and a pack could
  only say that its code sends `GET /owners/{ownerId}` somewhere: the route it
  calls is not a route it serves, so the edge onto it is UNRESOLVED and no walk
  follows one. When another project the same server serves answers that route,
  `flow` and `endpoint_impact` now keep walking there. Measured on
  spring-petclinic-microservices split into five packs, one per service:
  `flow` on the gateway's `GET /api/gateway/owners/{ownerId}` reached **nothing
  below the two client methods before, and the `owners` and `visits` tables in
  two other projects after**, each row carrying the project it came from and
  both packs named in `basis.siblings` with their own digests. The packs are
  untouched: the join is made when the question is asked, from a small
  `routes.json` index `analyze` now writes beside each pack (what this project
  serves, what it calls and does not serve). It is derived from the graph, so
  it is not an input to the digest, and a server refuses an index that no longer
  describes the pack beside it. A crossing is SOUND_SET at best, because which
  deployable answers a service name is not a fact about anybody's source, and
  HEURISTIC when a method was unreadable or several registered projects serve
  the route, in which case all of them are crossed and one `limits` sentence
  names them. A call no registered project serves is listed in
  `answer.federation.unmatched` rather than swallowed, on a single-project
  server too, because registering the project that serves it is the remedy. A
  project with no route index is named in `answer.federation.skipped` and in
  `projects`, with `cascade analyze` as the fix. Siblings are read from their
  committed packs, never from their working-tree overlays. `federate: false`
  answers from one pack alone, and `federationHops` (default 3) bounds how many
  crossings one question may chain.
- **The Java lane sees an imperative HTTP call, not only an annotated one.**
  Cascade already turned a `@FeignClient`/`@HttpExchange` method into a
  `CALLS_HTTP` edge, and saw none of the service-to-service calls that dominate
  real microservices: a `WebClient`/`RestClient` chain or a `RestTemplate`
  request, where the verb is a method name and the url is an argument somebody
  built. Measured on spring-petclinic-microservices, five services in one
  repository with no `@FeignClient` anywhere: **0 cross-service edges before,
  6 after**, every one of them SOUND_SET, and the gateway's own route now
  reaches the customers and visits tables through the hop instead of stopping
  at the service boundary. The url is read only as far as one file allows (a
  literal, a literal with `{…}` placeholders, or a `+` whose literal halves are
  kept and whose base is named rather than resolved); a `scheme://host` is
  stripped off and the host kept as evidence, because it is a service name and
  not a machine; the path is matched against the routes the pack serves with the
  web lane's own rule, and the profile's `gatewayRoutes` rewrites the prefix
  first. A url the lane could not reduce to a path draws **no edge** and is
  counted (`httpCallsUrlUnreadable`) rather than guessed into a route, and a
  call whose verb was an argument it could not read is matched on the path alone
  and graded HEURISTIC. Which deployable answers is still not knowable from
  source, so nothing rises above SOUND_SET.
- **Worker `javafacts/7` → `javafacts/8`**: the new `httpCall` record kind, and
  an `httpCalls` count on the header. The version rides in every fact-shard key,
  so the first run after this upgrade re-parses the Java tree rather than mixing
  two generations of facts in one graph.

- **A missing database schema is a signpost, not a footnote, and the password
  lives in your home.** On a tree with no DDL file, `init` used to record the
  connection it found in `application.yml` as one `[info]` line and tell you to
  edit the profile yourself, and `analyze` then built a pack whose ERD had no
  relationship lines and whose column answers were a fraction of what a schema
  gives (litemall: 4,064 column edges with its DDL, 684 without). Now `init`
  ends with a block that says what is missing, what it costs, and the three
  ways forward with exact commands, listing the connection candidates it found;
  `catalog fetch` writes `catalog.source: "jdbc"` into the profile itself on
  success; and `analyze` on a recorded but unfetched connection prints one
  reminder line up front and still ships the pack. The password never goes near
  the project: `cascade catalog credentials set|list|remove` keeps it in
  `~/.cascade/credentials`, one JSON entry per server and user, created 0600 and
  refused with a `chmod 600` remedy if anyone else could read it, never inside
  an analyzed tree. `fetch` looks in `--password-env`, then `CASCADE_DB_PASSWORD`,
  then that file, then a hidden prompt, and the target confirmation stays but
  becomes a `y/N` in a terminal. `list` never prints a password.

- **A runtime evidence lane: what actually ran, shown beside the grade and never
  above it.** No static reading of Java, with or without a build classpath, can
  raise an endpoint answer above `SOUND_SET`: the hop into a MyBatis mapper or a
  Spring Data repository is a runtime proxy with no source implementor, and a
  single static candidate is still not a proof of what runs. The one thing that
  can settle it is the running program. `cascade analyze --otel <file>` reads an
  OpenTelemetry trace, either one OTLP document or the log the Java agent writes
  with `-Dotel.traces.exporter=logging-otlp`, and marks the static edges the
  trace really crossed with `observed` and a count. It never raises a grade,
  never removes an unobserved candidate, and any hop it adds that the source
  does not explain is `RUNTIME_ONLY`, shown and never walked. `cascade
  otel-methods` prints the `otel.instrumentation.methods.include` list the agent
  needs (explicit method names, from the pack's own handlers and everything that
  reaches a statement), because without caller spans the dispatch join is
  empty. The viewer draws the mark: the seen tag on the rows that ran, a heavier
  connector on an observed hop, and a quiet trace chip in the masthead. Verified
  end to end on spring-petclinic under the real agent: 5 dispatch, 9 statement
  and 10 route observations matched, no grade moved, and a scrubbed capture of
  that run is now a fixture. The recipe is in `docs/setup/runtime-evidence.md`.

- **`cascade agent`: one command puts the server and the rule into a project.**
  The MCP server was wireable from a dozen places in the documentation, and not
  one of them said *when* the agent should ask. An agent with the server
  attached and no rule about it edits a mapper without a question, because
  nothing in its context says a question is due, and half of what this tool is
  worth sits on that rule. So `cascade agent --write`, run in the project,
  writes both: the MCP configuration with the absolute path to `bin/cascade.mjs`
  and the project id filled in from the registry, and a short block that names
  what to ask before editing (`changed_impact` first, `column_impact` before a
  rename, `flow` and `overview` for orientation) and how to read `trust`,
  `limits` and the grades that come back.

  `--client claude-code` (the default) writes `.mcp.json` and `CLAUDE.md`,
  `--client cursor` writes `.cursor/mcp.json` and an always-applied
  `.cursor/rules/cascade.mdc`, `--client codex` writes `AGENTS.md` and prints
  the TOML block for `~/.codex/config.toml`, which it does not own. Without
  `--write` every file is printed with its exact content and nothing is
  touched. A JSON config keeps every other key and every other server, and one
  that does not parse is refused by name with nothing written. The rules block
  lives between two markers, so a second run replaces it in place and the text
  around it survives, byte for byte.

## [0.1.0] - 2026-09-07

The first published release. Everything below was built and measured before it;
this heading only marks where the version numbering starts.

The first eleven milestones (M0–M11) are in. This section says what the engine
does, and — in the two lists at the end — separates what has been **measured**
from what has **not**, with the reason. Those two lists are the point of this
file; read them before the feature list.

### Added — the milestones, in order

- **M0 · hygiene gates.** Always-on repository gates: no internal coordinates
  (private IPv4, hosts outside a small allowlist, personal e-mail addresses,
  home-directory paths), English-only runtime strings, no NUL bytes in a source
  file, Apache-2.0 licence agreement, zero runtime dependencies, and every
  vendored viewer bundle credited in `NOTICE`.
- **M1 · the project layer.** `cascade init` discovers a tree and writes its
  `.cascade/` (manifest pinned to full commits, profile, a `.gitignore` that
  ignores `pack/` and `catalog/`), plus a home registry at
  `~/.cascade/registry.json`. Technologies with no lane come back as
  `UNSUPPORTED_TECHNOLOGY` diagnostics rather than being ignored.
- **M2 · the SQL lane.** MySQL DDL → catalog (tables, columns, types,
  nullability, comments); MyBatis XML → flattened statements; sqlglot lineage →
  table and column reads, writes and deletes.
- **M3 · calibration.** A sealed per-project baseline, a relative-drop gate in
  four modes, a **computed** trust level (never a typed one), a project golden
  corpus the tool proposes and a human approves, and a deployment receipt.
- **M4 · the Java lane.** A parse-only pass with the JDK's own compiler API — no
  Gradle, no Maven, no dependency classpath — that stitches
  `endpoint → controller → service → mapper` onto the SQL statement.
- **M5 · the DB catalog adapter.** `catalog discover` lists where a database
  might be, redacted, connecting to nothing; `catalog fetch` opens ONE read-only
  connection after printing the exact target and being told `--yes`, and pins a
  snapshot. Analysis reads the snapshot and never connects.
- **M6 · incremental analysis.** Content-addressed fact shards outside the tree,
  an invalidation plan from `git diff`, and one assembly that both the cold and
  the incremental path run through.
- **M7 · the working-tree overlay.** The dirty files are re-parsed on every
  call; nothing is written; every answer carries a session id and the sha256 of
  each dirty document; a node the base never had is marked `provisional`.
- **M8 · one server, many projects.** Registry-driven routing, lazy pack
  loading, an LRU under a memory budget.
- **M9 · the viewer.** Every project from the registry, a project switcher, deep
  links, and an English/Korean chrome.
- **M10 · the JPA / Spring Data lane.** Entities to tables, derived queries,
  JPQL, repository built-ins.
- **M11 · governance and release readiness.**
- **SQL identifier identity** (2026-09-05) — one identity per table, whatever
  the SQL spells. Below.
- **What the generality gate found** (2026-09-05) — two Java inheritance
  gaps, a multi-file catalog, MyBatis annotation SQL, and the gate itself as a
  regression test. Below.
- **The web lane's facts** (2026-09-06) — the frontend is read for the
  first time, and nothing is built from it yet. Below.
- **The viewer opens on the pack** (2026-09-06) — a browse rail with lists,
  filters and one-click picks, fed by a new `browse` tool. Below.
- **The source is readable where the claim is made** (2026-09-06) — a docked
  source pane, and one way back from every narrowing. Below.
- **Frontend calls reach the endpoint** (2026-09-06) — a frontend HTTP call
  becomes a graded `CALLS_HTTP` edge onto the route this pack serves. Below.
- **The web lane becomes incremental, reaches the working tree, and gains a
  declaration layer** (2026-09-06) — frontend facts are sharded per file, an
  edited `.vue` gets an answer from `changed_impact`, and an OpenAPI document
  supplies the routes the code did not. Below.
- **The screen axis** (2026-09-06) — a route declaration becomes a screen,
  the screen reaches the functions of the component it mounts, the frontend's own
  calls join a view to its api module, and the chain runs from the screen to the
  column and back. A browser recording is runtime evidence on the same edges.
  Below.
- **The page draws the screen end** (2026-09-07) — screens on the masthead, in
  the rails, on the chain, on the map and on the overview; the source pane opens
  frontend code. Below.
- **A function passed as a value is followed** (2026-09-07) — a view that
  hands its api function to a hook, rather than calling it, is a dependency the
  graph now carries; the screen axis is decided by what a run reads; the
  generality gate pins four frontends beside their backends. Below.

### 2026-09-07: a function passed as a value, a switch that reads the run, and four frontends the gate pins

The round that added the screen axis measured it on four frontends and one
number stood out: on the
largest, only 19 of 166 screens reached a table. The reason is a pattern, not a
bug in that project. Its views hand their api functions to a hook as VALUES
(`usePagedList({ api: list })`), so no call site names the function, and a rule
that follows calls sees nothing. A function passed as a value is a real
dependency and a sound candidate: whoever received it may call it.

- **`fnRefs` (`webfacts/3`).** Every call record now carries the identifiers it
  hands over: as an argument in any position, or as the value of an object
  argument's property one level deep, and only when this file binds that
  identifier to an import or to a function it declares itself. A member of a
  namespace import keeps its root and its path. A string is not a reference, a
  call is already a call, and an inline arrow's body is already attributed to the
  function around it. The index version does not move; the shard key carries the
  worker version, so every web shard is recomputed once and the run says why.
- **`symbol --CALLS--> symbol`, rule `passed-as-value`.** The bridge resolves a
  reference exactly as it resolves a callee, and grades the edge **SOUND_SET**,
  never EXACT: nothing here looked at whether the receiver calls what it was
  given, and the grade is the honest name for that. An assumed alias on the path
  lowers it to HEURISTIC. A pair that is both called and passed keeps the call's
  EXACT answer. The target takes part in the same "sends or leads to an HTTP
  call" fixpoint, so a screen can reach it. `laneStats.web.calls.passedAsValue`
  counts the references that resolved and `laneStats.web.callsByRule` splits the
  CALLS edges by the rule that found them, because a grade alone cannot tell a
  call this lane followed from a function that was only handed over.
- **The overlay's session id covers a frontend outside the root.** A file git has
  never seen is only listed for the directory the command runs in, so
  `ls-files --others` at the analyzed root could not see a NEW `.vue` beside it,
  in the same repository or in another one. That file is now found where it is,
  and its path and content hash enter the session id like any other dirty
  document.
- **The screen axis is decided by what a run READS.** `screenAxis.enabled` gains
  a third state: `null`, or the key absent, which is now the default. `true` and
  `false` stay the user's word and are obeyed whatever the run reads; the third
  state means "on when `frameworkPacks` names a router pack, or when a frontend
  package this run really reads depends on `vue-router` or `react-router`". It
  exists because `cascade init` discovers the ANALYZED TREE: a backend whose
  frontend is checked out beside it has no router package for `init` to find, so
  a run that read that whole frontend and resolved its calls onto real routes
  still built no screen at all, for a reason with nothing to do with the code.
  `cascade init` writes `true` when it finds a router package and leaves the key
  at `null` otherwise, and every run prints which of the three rules decided it.
- **A frontend that fetches its own menu is server driven whatever its size.**
  The rule used to need two halves: a call resolved to a route whose path ends in
  a menu spelling, AND fewer than 30 routes declared in the source. The call
  alone decides now; the 30-route ceiling survives only as the wording, between
  "most screens arrive when the app runs" and "screens beyond the N declared
  arrive when the app runs". The census gains `detectedBy: "menu-call"`. This is
  about what is MISSING and not about whether to build: a profile that turned the
  axis on still gets every declared screen.
- **The generality gate pins four frontends beside their backends.** A `CORPUS`
  entry may name a frontend that lives in its own repository (`front: {url, sha,
  dir}`); the runner clones it beside the backend and passes one `--web-src`.
  Two of the four frontends already sit inside their backend repository, so an
  unconfigured `init` reads them with no flag at all. `GUARDED` gains
  `webCallsResolved` and `screensReachingATable`, and the table prints both over
  their denominators.

Measured (2026-09-07), on the four pinned pairs, the engine as the previous
round left it against the
engine with this round in it, same trees, same flags:

| pair | CALLS edges before | after | of them passed-as-value | screens reaching a table |
|---|---|---|---|---|
| a shop backend with its admin in the same repository | 186 | 186 | 0 | 40 / 89, unchanged |
| a shop backend with its admin in its own repository | 174 | 174 | 0 | 44 / 54, unchanged |
| a management backend with its Vue 3 admin in its own repository | 132 | 132 | 0 | 8 / 21, unchanged |
| a low-code platform with its frontend in the same repository | 588 | **628** | 40 | 19 / 166, unchanged |

**The rule fires and the screen number does not move.** On the fourth pair 92
references resolved to a function this lane read, 40 became edges, 36 more
frontend functions became nodes and RENDERS gained 17 EXACT edges — and not one
of those 17 targets reaches a route this pack serves, so no screen crossed the
line. The 19 is not capped by this rule: 122 of the 166 screens have no RENDERS
edge at all, because the function-creation rule only makes a node of a function
that reaches an HTTP call, and most of those components' functions do not. The
web bridge's wall time is unchanged within noise (185 ms before, 188 ms after on
the largest pair; 13 to 15 ms on the other three).

**Where the 19 really comes from**, measured rather than assumed, because a
number that does not move is worth the same care as one that does. It is not the
rule's depth: a throwaway build that walked object properties two levels deep
made 102 passed-as-value edges instead of 40 and left `screensReachingATable` at
19. It is not RENDERS losing the `(setup)` pseudo-function either: there is not
one screen in that pack whose component file has a `(setup)` or `(module)`
symbol without a RENDERS edge onto it. It is the routes themselves. 122 of the
166 screens have no RENDERS edge at all; 91 of those name a component file, and
83 of those files contain no api import and no HTTP-shaped construct — 87 of the
91 are the framework's own demo pages. Meanwhile 40 pseudo-function symbols that
DO lead to a request sit in `views/system`, `views/openapi`, `views/super` and
`views/monitor`: real business screens that the static router never declares,
because that product fetches its menu from the database at run time. The engine has a name for
that condition, and it still does not fire here — not because of the route count,
which no longer counts, but because that product's menu rides on a route named
after PERMISSIONS rather than after menus, which no generic spelling matches.
Naming it here would be a rule that works on one project, so the gap is written
down in `docs/setup/web-lane.md` instead of closed with a literal.

The gate, over all eleven repositories, at the new baseline: **the three reach
counts did not move by one**, and the two new columns are recorded for the first
time — 122/142, 172/191, 219/233, 145/153, 538/929 and 165/221 web calls onto a
route on the six repositories that have a frontend, and 44/54, 40/89, 19/166,
8/21, 0/44 and 0/7 screens onto a table on the six whose screen axis is now on.
The third state is what put the first and the fourth of those on the board: both
are a backend and a frontend in two repositories, and before it they measured
0 screens each with nothing wrong but the switch.

### 2026-09-07: the page draws the screen end

The round that built the screen axis put the screen end into the engine and the
tools; the page drew none of it.
The masthead's rail stopped at api groups, the chain had no lane left of the
endpoint, the map had no screen, and the source pane could not open a Vue file.
This round makes the page say what the engine knows, under the same rules as the
rest of it: every number is an answer, a missing axis is named as not shipped,
and a runtime-only mark is shown and never drawn as a walked line.

- **The masthead and the overview.** The rail starts with screens in three
  states — the count when the axis is shipped, the count with a tilde and the
  engine's reason as the title when degraded, "not shipped" with the reason when
  it is not. The overview gains a fifth dial (screens that reach a table), the
  server-driven note under it when the router is filled in at run time, the five
  screens reaching the most tables as a list that opens Flow, and gap chips for
  screens from the server, components unresolved and screens seen at run time. A
  pack with no frontend gets one line and no request.
- **The rails and the chain.** Browse lists screens as an Explore kind with a
  screen card (path, title, group, the component with a Source link, the
  functions it renders, the endpoints reached with their grades, the tables, and
  `seen` when a recording confirms a pair); Flow switches between endpoints and
  screens, remembered per project. The chain has six lanes down from a screen and
  closes with the frontend functions and the screens walking up. The depth
  control raises itself to the engine's screen default of 8 only while it still
  sits at the tab default, because a screen walk at depth 6 answered two lanes of
  "none" when the truth was the cap.
- **The source pane and the map.** A web function opens by brace balance from its
  recorded line inside a Vue file's script block, with real file lines and a
  60-line window that says so when the braces do not close; a screen opens its
  component file whole with the script's first line marked; JS, TS and TSX are
  painted. The map gains a screens layer: one node per screen that reaches a
  drawn route, folded with the route's group, on by default up to 300 screens and
  cut last with the tables.
- **Two colour tokens per theme** for screens and frontend functions, contrast
  checked by the token test. **The DOM stub keeps text nodes**, so a select
  reports its option's value and the stub tests render real chains for the first
  time.

Measured: checked in a real Chrome on a 89-screen frontend — the overview's fifth
dial at 45 percent with the screens layer live on the map, Flow from one screen
with six lanes at depth 8, Impact from a column closing with the frontend
functions and the screens, and the source pane on a screen's component with the
script line marked. Node tests 1826 -> 1851.

Not verified by a test: the canvas itself; the `seen` mark on a real pack (no
corpus recording exists, so only the stub fixture carries one); and the 1100 px
overview grid putting the fifth dial alone on a third row.

### 2026-09-06: the screen axis, and a recording as runtime evidence

The product's round trip is `screen -> API -> service -> mapper -> SQL -> table
-> column` and back. The round that first read the frontend recorded the
router's route declarations and the round after it attached the frontend's HTTP
calls to the endpoints, but nothing said WHICH
SCREEN a call belonged to: a view that calls `listGoods()` from an api module was
"read with no facts", because calls between frontend functions were not in the
graph. This round closes both ends of it.

- **Screens.** A route declaration is not a screen; a screen is the path a user
  is really on, composed from the parent chain (an absolute child replaces its
  parent, an empty parent contributes nothing, a redirect that mounts nothing is
  not a screen, and two declarations that compose to one path are one node that
  lists both). Each carries its name, `meta.title`, label, code, group,
  component, declaration site, router pack and whether the path has a parameter.
  The profile keys `screenAxis.enabled` / `.nameSource` / `.pathRule` /
  `.codeRegex` and `moduleAttribution.codeLength`, recorded and not acted on
  since M2, are all CONSUMED here; `nameSource: "jsdoc-comment"` is refused by
  name, because no lane reads the comment above a component.
- **RENDERS.** `screen --RENDERS--> symbol` is EXACT onto the functions of the
  file a route declares, and SOUND_SET onto the functions of a component that
  file imports (up to four levels, cycles cut, the import chain on the edge).
  Nothing is guessed from a name: a file that is imported is a candidate, a file
  that is not is not, and a component that could not be resolved gets no edge and
  is counted with the specifier that failed.
- **The missing hop.** `symbol --CALLS--> symbol` between frontend functions:
  EXACT through a static import or a name inside one file, SOUND_SET through an
  `export *` barrel, HEURISTIC through an assumed alias. Only a function that
  sends a request, or reaches one through these edges, becomes a node, so the
  pack does not double in size for formatters and date helpers.
- **The chain reaches both ends.** `flow screen=<path>` walks down from a screen
  through its component's functions, the api functions they call, the routes those
  call, and on to the services, statements and tables; walking up from a column
  the same two lanes appear at the far end. `walk.laneNames` says which lanes an
  answer has, because a backend-only pack has neither and an empty `screens`
  column would read as "no screen reaches this".
- **The tools.** A new `screen_impact` (which screens does a change to this
  column / table / statement / method reach, through which routes, and was it
  ever observed), `browse kind=screen`, `flow` list mode `kind=screen`,
  `screens: {count, sample}` on every `endpoint_impact` row, `touched.screens` on
  `changed_impact`, a `screens` block and a `screens-from-server` gap on
  `overview`, and screens in `search` and `neighborhood`.
- **A recording is runtime evidence, and is graded as one.** `--har <file>` (or
  the new profile key `runtimeEvidence.har`) reads a browser recording: every
  request that matches a route this pack serves, after the same prefix rules the
  web bridge applied, becomes a `screen --CALLS_HTTP--> endpoint` edge graded
  RUNTIME_ONLY, which sits below every mode's floor. It is SHOWN (`observed`) and
  never walked, and it never raises the grade of the static edge beside it. A
  page the source never declared becomes a screen with `source: "har"` and no
  RENDERS edge. Nothing is discovered: a recording is made on purpose.
- **The axis says when it is not the whole picture.** `screen` is `shipped` only
  when the gate is on, a screen reaches a function, and nothing was guessed. It is
  `degraded` when the router is filled in by the SERVER at run time (the rule,
  stated in the reason: fewer than 30 routes declared in the source AND a call
  that fetches the frontend's own menu), when more than a fifth of the routes name
  an unresolvable component, when `nameSource` asks for something not shipped, or
  when nothing hangs off any screen. `trust.knownGaps` now carries
  `screen-axis-not-shipped` only when the axis really is not shipped.

### 2026-09-06: the web lane becomes incremental, reaches the working tree, and reads a contract

The round before this one attached a frontend call to an endpoint. Three things
were still missing,
and each one is what a person actually hits: every run re-read every frontend
file, an edited `.vue` had no answer at all, and a backend this engine has no
lane for left the frontend's calls pointing at nothing.

- **`webfacts` shards, one per file.** The web lane's facts are now
  content-addressed exactly like the Java lane's: `sha256(file bytes) + the
  worker version + the file's root-relative path`. `splitWebFactsByFile` /
  `assembleWebFacts` reproduce the worker's own byte stream, pinned against real
  worker output in `test/facts_store.test.mjs`, because the bridge's maps are
  last-write-wins in places and the same multiset is not the same answer.
- **The package configuration is never cached.** A `.env` value, a dev-server
  proxy rule and a path alias describe a PACKAGE, not the file they are written
  in, so no shard could hold them honestly and they reshape every URL the
  frontend sends. Every run reads them again through a new `--configs-only` mode
  that parses no source file.
- **The bytes decide, not the changeset.** `--configs-only` also LISTS the files
  the lane would read, and an incremental run reuses a shard only when the key
  derived from the file's current content is the key the index recorded. That is
  not tidiness: `--web-src ../front/src` is the common case and the frontend is
  as often a separate repository, where a diff of the analyzed root reports
  nothing at all. Measured before the fix, on two of the four pairs, one edited
  URL literal produced two different digests. It now produces one.
- **`INCREMENTAL_ENGINE_VERSION` is `cascade-incremental/2`.** The shard layout
  changed, so every existing project takes one cold run and the run says so.
- **The overlay carries the frontend.** `classifyDirtyFiles` gained
  `web` / `webDeleted` / `webConfig`; `runOverlayLanes` re-reads the dirty
  frontend files and the package configuration; `overlayGraph` runs the web
  bridge over the spliced shards. A frontend edit answers DOWN — `touched.webSymbols`,
  `calledEndpoints`, and the columns those routes reach — and a backend edit puts
  `frontendCalls` on every affected route, so the half of the blast radius that
  is not below the edit is on the row. A frontend that lives outside the analyzed
  root gets its own `git diff`, against its own HEAD, because there is no commit
  the two repositories share.
- **OpenAPI documents (EXACT by declaration).** `src/adapters/openapi_bridge.mjs`
  reads an OpenAPI 3 or Swagger 2 document in JSON or in a YAML subset written
  here (block mappings and sequences, plain and quoted scalars, comments, flow
  collections, `|`/`>` block scalars). Anchors, aliases, tags, a second document
  and a tab in the indentation are REFUSED BY NAME, with the line, and the whole
  document is then unread: a YAML feature silently mis-parsed would put routes in
  the pack that the file does not declare. Every `(method, path)` becomes an
  endpoint with the id the Java lane would give it, so a route both name is
  corroborated (`declaredBy`, `operationId`, `summary`) and a route only the
  document names is added with no handler edge. `--openapi` / `--no-openapi`,
  `openapi.documents` in the profile, discovery by a top-level `openapi:` /
  `swagger:` key, and the bridge runs before the web bridge so a frontend call
  can land on a route only a document declares.
- **What the drift readout is for.** The document and the code are two
  independent statements about the same routes. `meta.laneStats.openapi` and the
  overview's `openapi-drift` gap name both directions — declared and not served,
  served and not declared — and judge neither. With no Java lane at all the
  `code` axis is `degraded` with the reason "endpoints come from an OpenAPI
  document, not from source: the routes exist, but nothing below them is walked,
  so a frontend call reaches an endpoint and stops there", and a column question
  answers `not-shipped` rather than an empty list that would read as "we looked".

Measured, on the same four public front/back pairs (2026-09-06). Each pair: a
cold analyze, then a no-op comment appended to one frontend file, then an
incremental analyze. **The two digests are equal on all four**, and the real edit
that follows (one URL literal moved) moves the digest and re-reads exactly one
file:

| pair | frontend files | cold | incremental | reparsed / reused | digests equal |
|---|---|---|---|---|---|
| an admin frontend on a shop backend | 119 | 1951 ms | **438 ms** | 1 / 118 | yes |
| a Vue 3 admin on a management backend (separate repo) | 160 | 1370 ms | **290 ms** | 1 / 159 | yes |
| a Vue admin on a large shop backend (separate repo) | 127 | 3127 ms | **458 ms** | 1 / 126 | yes |
| a low-code platform's frontend on its own backend | 1614 | 12586 ms | **1033 ms** | 1 / 1613 | yes |

The overlay, on the first pair, one edited `.vue` that calls the API: **179 ms**
for the lanes (load-base 19, java 0, web 75, sql 24, graph 61) against a
one-second gate, answering `litemall-admin/src/views/goods/list.vue#getList` →
`GET /admin/goods/list` (SOUND_SET, provisional) → 21 columns. An edited
controller on the same pair returned six affected routes, each carrying
`frontendCalls: 1`.

The OpenAPI lane, on the web fixture with a document and no Java lane: 12
declared routes, `meta.lanes` `['sql','openapi','web']`, **11 of 13 frontend call
sites resolved** (10 SOUND_SET) onto routes nothing in the pack serves, the
`code` axis `degraded` with the reason above, and a column question answering
`not-shipped`. **None of the four corpus backends ships a static OpenAPI
document**, so there is no corpus drift census to report; what the discovery rule
did find on one of them was a Spring Boot `application.yml` carrying a
`swagger:` configuration block, which the rule now excludes by requiring either a
recognised version or a `paths` section.

NOT done, on purpose, and each one is a named round:
- **no HAR / APM input** — a recording has no caller function, so it attaches to
  a screen, and there is no screen node yet;
- **no screen node**, so still no `screen → endpoint` path;
- **no edge between frontend functions** — a `.vue` that only calls an api module
  has no route under it; one that names a URL itself does;
- **the viewer does not show frontend callers on the Flow or Impact chain** —
  the count is on the row in `My edits` and in `endpoint_impact`, not on the
  picture;
- **no `$ref` resolution** inside an OpenAPI document.

### 2026-09-06: frontend calls reach the endpoint

The round that first read the frontend built nothing from it. This round joins
the two
halves: a frontend function that calls `/orders/` + id is now an edge onto the
`GET /orders/{id}` this pack serves, so a column-impact answer reaches past the
controller into the code that calls it, and the reverse walk from a screen's API
function reaches the tables it touches.

- **`src/adapters/web_bridge.mjs`.** Injected like the other bridges and run
  LAST, because it needs the routes the Java bridge put in the graph. It
  resolves each call's callee to what it is BOUND to (across files, through
  aliases, re-exports and `export *` barrels), traces the project's own wrappers
  down to the client library that sends the request, works out the prefix the
  call goes through, and matches the result against the routes this pack serves.
- **Graded, honestly.** SOUND_SET for a platform sink (`fetch`,
  `XMLHttpRequest`), for an HTTP client library a declaration pack names, and for
  a wrapper traced back to one. HEURISTIC when the call could not be traced to
  any sink, or when the prefix was chosen by counting matches, a path alias was
  assumed, or the call carries no method. UNRESOLVED when the URL resolved and
  nothing here serves it: the route becomes an `outbound` node marked
  `source: "web"`, the edge is below every mode's floor, and it is counted. A URL
  that never resolved gets no edge and is counted by reason.
- **The wrapper chain, by shape and not by name.** A class whose `get(config)`
  returns `this.request({ …config, method: 'GET' })` and whose `request(config)`
  returns `this.inner.request(config)` is followed to the `axios.create` its
  constructor put on a field. The chain and its depth are on the edge. The
  worker learned four shapes for this (`webfacts/2`): `class` records, `assign`
  records for `this.field = …`, a `this`-rooted callee that says which class it
  is in, and what a function RETURNS.
- **The prefix, said out loud.** Per client instance: `declared` (the profile's
  `gatewayRoutes`), `derived` (the base URL read from the source, with the
  dev-proxy rule that explains it applied), `auto` (nothing states it, so
  candidates were matched against the routes and the best was taken — a guess,
  and every edge through it is HEURISTIC with the candidate counts on it), or
  `none`. `gatewayRoutes` is consumed here and nowhere else (I-5).
- **A declaration, not a rule.** `adapters/web/packs/http-clients.json` names
  the platform sinks and the client libraries (axios, ky, superagent) with their
  verbs. A new library is a row in that file. **No project name and no wrapper
  name is anywhere in the lane**, and a gate fails the build on any of the
  corpus spellings appearing in the bridge, the worker, a pack or the fixture.
- **In the answers.** `endpoint_impact` and `flow` (walking up) put
  `frontendCalls` on an endpoint row when a frontend calls it; `search` finds a
  frontend function by its file or its name; `neighborhood` walking up from a
  route lists the screens' functions. `overview` gains a `web` block and splits
  the frontend's misses out of `http-calls-leaving-pack`; `estimate` gains
  `webCallsResolved`. The `web` axis is `shipped` only when nothing had to be
  guessed, and `degraded` names what to declare.

Measured, on four public front/back pairs (2026-09-06), against an independent
grep-level oracle's floors (method ignored):

| pair | call sites with a URL | resolved (sound + heuristic) | oracle floor |
|---|---|---|---|
| an admin frontend on a shop backend | 127 | **121** (121 sound) | 122 |
| an admin frontend on a management backend | 142 | **122** | 118 |
| a Vue admin on a large shop backend | 153 | **145** | 145 |
| a low-code platform's frontend on its own backend | 929 | **538** (537 sound) | 475 |

The one pair below its floor is one call: the frontend asks for a route with
`GET` that the backend serves with `POST`. The oracle ignores the method; this
lane does not, so it reports the mismatch as a miss rather than as a reach.

NOT done, on purpose, and each one is a named round:
- no OpenAPI reader, so no EXACT grade on this lane;
- no HAR / APM input, so a URL that only exists at run time stays unresolved;
- no screen node, so no `screen → endpoint` path;
- no edge between frontend functions, so a chain starts at the function that
  names the URL rather than at the component;
- **no caching** — the web facts are still not sharded.

### 2026-09-06: the source is readable where the claim is made

The user, on the build the browse rail shipped in: once you pick something,
getting back to the whole
is cumbersome, and the box that shows source code was 286 by 360 pixels at 12 px
in the side panel — 35 lines of a statement with 673 px of scroll behind it, no
line numbers, no mark on the line the answer is about, no path to copy.

- **One source pane for the whole page**, docked to the right edge over the
  content with no scrim, so a reader keeps clicking rows while it updates in
  place. It opens only when asked for and then follows every later pick; after
  Escape it stays closed until asked again. A line-number gutter with the file's
  real lines, the extracted range marked and scrolled to, snippet and whole-file
  modes, and a header carrying the node id, the path (click copies `path:line`),
  the line range and Open in editor (VS Code / IntelliJ / copy). The footer says
  why this code is in the answer: the grade and the edge that led here.
- **`/api/source`** answers `abs`, `from`, `to` and `fileLines`, and `?whole=1`
  returns the file text capped at 1 MB with the note saying so.
- **One way back.** A Show all button on Explore, Flow, Impact, Graph and ERD,
  enabled only while the tab is narrowed, returning it to its opening state;
  Escape does the same. Every pick pushes a hash state, so the browser's Back
  button returns to the previous picture and a reload lands on the same pick.
- **Labels instead of glyphs** on the rail (`sql 22`, `api 29`, `r 8`, `w 8`),
  and on a pack that calls routes it does not serve the count line says so.

Not verified by a test: the pane was checked by hand in a real Chrome (the
gutter on a mapper statement, whole-file mode keeping the mark, a stored drag
from 968 to 642 px, the `vscode://` link, Show all returning Flow to its opening
state). Tests: 1616 -> 1649 node, 182 python.

### 2026-09-06: the viewer opens on the pack, not on an empty box

The user, live on the page: entering Explore, Flow or Impact showed a search
box first; it would be better to show something by default, and to let me look
at a list, pick from it and filter it. Coupling and Transactions already opened
on content; these three did not.

- **A browse rail** down the left of the three tabs: the kinds that tab can
  list, each with its count from the server; a filter that narrows the rows
  already loaded and sends no request; a sort whose default puts the busiest
  first; `show more` paging; the picked row staying marked while the right side
  renders. `/` focuses the filter, the arrow keys move, Enter picks. Under
  1100 px it is a drawer behind a Browse button.
- **Flow groups its endpoints** under their API group with sticky headers, and
  **Impact gives every table a caret** that opens its columns in place, each
  with its read and write counts.
- **One new MCP tool, `browse`** (kind, query, table, sort, limit, offset), so
  the page counts nothing itself: every row and every number is an answer. The
  three "how many endpoints reach this" numbers come from ONE per-pack
  `walkEndpoints` census at conservative / depth 8, memoised and inverted, and
  every answer names that walk in its limits.

Measured: the first `browse` answers in 14 ms on mall and 38 ms on jeecg
(969 served endpoints), later ones under 1 ms and under 2 ms. Opening a tab
costs one request; typing costs none.

Not verified by a test: the three tabs, a pick, a filter and the column tree
were checked by hand in a real Chrome at 1440 by 900, and the rail's numbers
were re-derived from the pack independently. Tests: 1583 -> 1616 node, 182
python.

### 2026-09-06: the web lane's facts

The product's round trip starts at the screen. Until now the graph started at
the HTTP endpoint and a frontend package was an `UNSUPPORTED_TECHNOLOGY`
diagnostic. This round reads the frontend. **It adds no node and no edge**, and
saying so plainly is half the point of the round: an impact answer with no
frontend in it must not be readable as "nothing calls this".

- **A vendored parser.** `@babel/parser` 7.29.8 (MIT) at
  `adapters/web/vendor/babel-parser.cjs`, copied byte for byte from the
  published tarball. The engine still has no npm dependency and still makes no
  network call at analysis time; the parser is pinned to a sha256 that a gate
  recomputes, because a parser that could move under the engine would change
  what every cached fact means.
- **A file-local worker.** `adapters/web/webfacts.mjs` reads `.js`, `.mjs`,
  `.cjs`, `.jsx`, `.ts`, `.tsx` and the `<script>` blocks of `.vue` files, and
  prints JSONL. It resolves nothing across files. Two runs over the same tree
  print identical bytes.
- **What it records.** Per file: imports and exports; named functions, with a
  callback attributed to the nearest named function rather than given a name of
  its own; string constants and enums; top-level bindings including the
  `baseURL` an HTTP client is built with; and every call site that goes through
  an import or a local binding, carries a URL-looking argument, or is `fetch` /
  `XMLHttpRequest.open`. A call's URL is resolved as far as one file allows: a
  literal, a template (`'/x/' + id` and `` `/x/${id}` `` both become `/x/{*}`), a
  member of a constant declared in the same file, or a local `const` followed
  once. What it cannot resolve says which kind of unresolved it is.
- **Routes from declaration packs.** `adapters/web/packs/*.json` name the keys a
  router convention uses; `vue-router` and `react-router` ship. Adding a
  convention is a JSON file, not a code change. **No wrapper name and no project
  name is in the engine**: what a project calls its HTTP wrapper is what the
  call-site SHAPE is recorded for, and a test fails the build on any of the
  corpus spellings appearing in a rule or a fixture.
- **The project's own wiring.** Dotenv values, dev-server proxy rules from
  `vue.config.js` and `vite.config.*` (with the rewrite read, not just noted),
  and path aliases from `tsconfig`/`jsconfig`, the bundler config and
  `chainWebpack`. When nothing declares `@` and `<pkg>/src` exists, the record
  says `assumed`.
- **The plumbing.** `--web-src` / `--no-web`, discovery counts and per-package
  records, `frameworkPacks: web` (plus `vue-router` / `react-router`) from
  `cascade init`, a `web` line in `cascade estimate`, a `web lane parser` check
  in `cascade doctor`, `pack.meta.laneStats.web`, and the web roots in the lane
  selection so a project that gains the lane takes one cold run and says why.

A directory is only output where output goes. `dist`, `build`, `coverage` and
`public` are skipped as a direct child of a source root or of its package
directory, and walked anywhere deeper: a blanket rule on the name alone dropped
`src/views/tool/build/`, a form BUILDER worth six real screens, from one of the
five frontends below without a word.

Measured, on five public frontends (2026-09-06, the worker run directly):
1615 / 161 / 128 / 120 / 70 files read in 0.60s / 0.11s / 0.10s / 0.11s / 0.08s,
**zero parse errors and zero recovered errors on all five**, 935 / 153 / 155 /
132 / 65 call sites carrying a URL, and 173 / 21 / 54 / 57 / 39 route
declarations. On the largest of the five, 86% of the URL-carrying call sites go
through one identifier, which is the number the next round starts from. Every
`request({ url: '…' })` in one project's whole API directory came back as a call
with a resolved URL, counted both ways: 123 and 123.

NOT done, on purpose, and each one is a named round:
- no `CALLS_HTTP` edge from a frontend call to an endpoint (that is next);
- no screen node, so no `screen → endpoint` path;
- no mapping of a call's prefix through a proxy or gateway onto a backend route;
- **no caching** — the web facts are not sharded, so every run re-reads every
  frontend file.

### 2026-09-05: what the generality gate found, and the gate itself

Four gaps a run over six unseen repositories exposed, and the run turned into a
regression test. Every number below was measured on the pinned corpus, and the
before/after was taken with the SAME script over the SAME commits.

- **A receiver that is a field inherited from a superclass** (Java language).
  The worker used to fold two very different things into one silent skip. It now
  tells them apart: a receiver the compilation unit DECLARES (a local, a
  parameter, a field it could not type) stays a skip and is counted as
  `skippedLocalReceivers`, while a receiver the file declares NOWHERE is emitted
  as a `call` record carrying the NAME and no type (`via:"identifier"`). The
  bridge — which holds every type record — walks the `extends` chain to the
  nearest ancestor that declares such a field, binding a field typed by a type
  PARAMETER through the subclass's own `extends` arguments, so 32 DAOs sharing
  one `protected MYBATIS_MAPPER mybatisMapper` each reach exactly one mapper and
  never all 32. Rule `inherited-field`; a receiver that turns out to name a TYPE
  is counted apart as a static call rather than as a failure of this rule.
  DolphinScheduler: endpoints reaching a statement **75 → 185** of 239, tables
  26 → 42, columns 313 → 449.
- **Dispatch to a method the implementor inherits and does not override**
  (Java language). `tenantDao.deleteById(id)` resolves to the interface, and the
  implementor declares nothing — it inherits the body from a generic base — so
  the chain used to end on an empty symbol. The inherited member is now
  INSTANTIATED for the concrete class: one symbol carrying `inherited:true`, the
  ancestor's file and line (so the source preview opens the code that runs), and
  the ancestor's calls with this subclass's type arguments substituted. Rules
  `interface-dispatch-inherited` and `inherited-member-call`. DolphinScheduler:
  **185 → 204** of 239 endpoints, columns 449 → 457, and one
  `TenantDao#deleteById` reaches exactly one mapper.
- **A catalog from several DDL files** (repo shape). `--ddl` is repeatable and
  accepts globs, `catalog.connectionFrom` takes a string or an ordered array,
  and with neither the discovery classifies every `.sql` by **dialect** (from the
  path first — `db/mysql/…`, `schema_h2.sql` — and otherwise from spellings only
  one database has) and by **role** (`schema` when it declares tables,
  `migration` when it changes more than it declares or sits under a
  flyway/liquibase/migration/upgrade/patch path). The default is every schema
  file of the project's dialect in path order; migrations and files under
  `src/test/` are not applied, and every file is printed with the reason.
  `catalog_ddl.py` (**catalog-ddl/2 → /3**) folds the files in order and applies
  `ALTER TABLE ADD/DROP/MODIFY/CHANGE COLUMN`, `ALTER … RENAME TO` and
  `RENAME TABLE`; two files declaring the same table under the run's identifier
  rule yield `DUPLICATE_TABLE_DECLARATION` with the first kept and nothing
  merged. The catalog shard key covers the whole file set in order.
  spring-petclinic-microservices ships three `db/mysql/schema.sql`, one per
  service, and now has a **shipped catalog of 7 tables** (types, owners, pets,
  vets, specialties, vet_specialties, visits — hand-counted across the three)
  where it had none.
- **MyBatis annotation SQL** (framework). `@Select`/`@Insert`/`@Update`/`@Delete`
  on a mapper method is a statement with no XML anywhere. The worker records the
  text in the three spellings MyBatis accepts (one literal, a `+` concatenation,
  a `{ "…" }` array joined with a space) as `mapperAnnotationSql`, and the bridge
  writes each mapper's statements as a SYNTHETIC mapper XML into the run's
  scratch directory so `mybatis_extract.py` flattens `<script>` bodies with the
  same `<if>`/`<foreach>`/`<where>` rules a real mapper gets — one flattener, not
  two. The statements are re-stamped onto the Java file and the annotation's
  line. A method carrying both an annotation and an XML statement is reported
  (`MAPPER_STATEMENT_DECLARED_TWICE`) and the XML wins. DolphinScheduler: 9 more
  statements from 4 mappers; jeecg-boot: 53, which is exactly its 41 `@Select`,
  6 `@Update` and 6 `@Delete`.
- **Worker `javafacts/6` → `javafacts/7`**: `skippedLocalReceivers` split out of
  `skippedCalls`, a `call` record with `via:"identifier"`, `declaredMethodLines`
  on the type record, and the new `mapperAnnotationSql` record kind.
- **The gate is a script and a test.** `scripts/generality-gate.mjs` holds the
  pinned corpus (eleven repositories, each with a full sha), `--fetch` clones
  them into `$XDG_CACHE_HOME/cascade/gate` and never inside the tree, and a run
  takes no per-project flag beyond what the corpus records.
  `test/generality_gate.test.mjs` compares the result against
  `test/fixtures/generality-gate.baseline.json` and fails when any repository's
  endpoints-reaching-a-statement, tables reached or columns reached falls BELOW
  the baseline; a rise changes nothing until `--accept` rewrites it with the diff
  printed. It skips loudly when the clones are absent, and CI runs it in its own
  `gate` job — weekly and on `workflow_dispatch`, not on every push, because the
  clones are about a gigabyte.

### 2026-09-05: SQL identifier identity

- **`sqlIdentifierCase`, a declared per-dialect identity rule.** Whether two
  spellings of a table or column name the same object is a property of the
  DATABASE, so it is now a small declared table with the manual behind each row
  — `src/core/identifier_case.mjs` and its mirror
  `adapters/sql/identifier_case.py`:

  | dialect | identifier case | why |
  |---|---|---|
  | `mysql`, `mariadb` | `fold-lower` | column names are always compared case-insensitively; table-name sensitivity is the server's `lower_case_table_names`, and lower is the portable setting the MySQL manual recommends |
  | `postgres` | `fold-lower` | unquoted identifiers fold to lower case |
  | `oracle` (incl. `oracle-11g` / `oracle-19c`) | `fold-upper` | unquoted identifiers fold to UPPER case |
  | `hsqldb`, `h2` | `fold-upper` | SQL-standard folding to UPPER case |
  | anything else | `exact` | fail closed — a fold that cannot be cited would merge two different tables |

  The profile key `sqlIdentifierCase` (`fold-lower` / `fold-upper` / `exact` /
  `null`) overrides the dialect's rule; `null` takes it. It is routed exactly
  once (`src/core/lanes.mjs` → `lineage.py --identifier-case`), it is in
  `PROFILE_KEY_CONSUMERS`, and every run announces which rule it used and where
  the rule came from.
- **The fold is a MATCHING key, never a rename.** The catalog is indexed twice
  over — by the folded key and by the spelling it was declared with — and every
  emitted fact carries the declared spelling. `pms_product` is still
  `pms_product` in the ERD and in every answer; only the comparison changed.
  Consequently the fold DIRECTION is invisible in the output: on jpetstore,
  `fold-lower` and `fold-upper` produce byte-identical lineage
  (`test/jpetstore.test.mjs` asserts it).
- **A quoted identifier stays exact.** `"Item"` / `` `Item` `` is exact in every
  dialect here, so it is matched against the catalog's declared spellings only
  and never folded onto another. Quoting survives `qualify` (which is now run
  with `quote_identifiers=False`), and the catalog is handed to sqlglot under
  both its folded key and a quoted display key so a quoted reference still gets
  its star expanded.
- **A folded collision is reported, not merged.** Two catalog names that fold to
  one key (`Item` and `ITEM` under a folding rule) produce a
  `folded_identifier_collision` warning naming both; the first declaration keeps
  the key, and both tables stay in the pack as declared. Under `exact` the same
  catalog is simply two tables and there is nothing to report.
- **`hsqldb` and `h2` are dialects the profile accepts.** SQLGlot 30.17.0 ships
  no parser for either — its `Dialects` enum has 33 names and neither is among
  them — so both route to SQLGlot's DEFAULT (ANSI) parser, which is what the
  code says rather than a dialect claim it cannot back. Measured on jpetstore:
  the ANSI parser and the MySQL parser parse all 25 mapper statements with zero
  diagnostics, and analysing the fixture as `hsqldb` produces the SAME pack
  digest (`5b7f4db948db`) as analysing it as `mysql`.
- `test/identifier_case.test.mjs` — the fold table, the profile key, the bridge,
  and a **mirror gate**: it runs the JavaScript and the Python fold over the same
  20 names × 3 rules × 11 dialects and fails if they disagree. Both fold ASCII
  A-Z only, so a locale case rule (the Turkish dotless i, on which Python's
  `str.lower()` and JavaScript's `toLowerCase()` differ) cannot split them.
- `adapters/sql/test_identifier_case.py`, and identity cases in
  `adapters/sql/test_lineage.py`: an UPPER-case DDL with lower-case SQL and the
  reverse, both resolving to the catalog's spelling.

### 2026-09-05: governance and release readiness

- `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md` (Contributor Covenant
  2.1, CC BY 4.0) and the `DCO` (Developer Certificate of Origin 1.1). All four
  are scanned by the hygiene gates.
- `scripts/check-dco.mjs` + `test/dco.test.mjs`: every commit in a range must
  carry a `Signed-off-by:` trailer whose e-mail is the **author's own**. A new
  `dco` CI job runs it on every pull request with `fetch-depth: 0`.
- `cascade doctor` + `src/core/doctor.mjs` + `test/doctor.test.mjs`:
  one table for Node, git, the SQL lane's venv and `sqlglot`, a JDK (naming
  which candidate won and why the others did not), the three optional DB
  drivers, Docker, the registry and the cache directory — each with a status and
  a remedy. `--json` for the raw report. Exit 0 only when every *required*
  prerequisite is ok.
- The JDK lookup is now **one** ordered list (`jdkCandidateDirs`), shared by
  `analyze`, `doctor` and the java smoke script, and it looks in
  `$JAVA_HOME`, sdkman, `/usr/lib/jvm/default-java` and both Homebrew kegs
  before falling back to PATH, because a lookup that only works on one OS is
  not a lookup.
- A docs site under `docs/` (`index.md`, `concepts.md`, `cli.md`, plus the
  existing `mcp.md`, `viewer.md` and `setup/*`), GitHub-Pages-ready with no
  bundler and no npm. `test/docs.test.mjs` is a **drift gate**: it runs the
  binary, reads the command names and flags out of the usage text it prints, and
  fails when `docs/cli.md` misses one — or documents one that no longer exists.
  The same for `toolList()` against `docs/mcp.md`, plus a check that no page
  makes a forbidden claim.
- `test/jpetstore.test.mjs`: the SQL lane end to end over mybatis/jpetstore-6,
  pinned at `ebb36b3`, with every count read out of the fixture and the command
  that produced it recorded beside the assertion.
- `test/mall_demo.test.mjs`: the large demo as a golden. It clones
  macrozheng/mall at `0504e86`, runs `init` and `analyze` **with no lane flags**
  — the two commands the README prints — and asserts the pack digest and the
  numbers the README claims.
- `test/helpers/mall_fixture.mjs`: one guard in front of every mall-pinned test,
  replacing four copies that had drifted in their wording. Absent → skip naming
  the rebuild command; a different digest or base commit → skip naming both.
- A `fixtures` CI job (independent, like the other six) that clones both
  fixtures at their pins, **builds the mall pack**, runs the goldens, and fails
  if any of them skips.
- Viewer i18n completeness: the panel headings and prose the page writes beside
  an answer — the Graph map's legend and lead card, the Flow/Impact side panels,
  the ERD side and its "no join witnessed" strip — moved into the catalogue and
  re-rendered on a language switch **from the answer already in memory**. A test
  asserts that switching language puts nothing on the wire.
- `package.json` gains `bin`, `files` and the `doctor` / `dco` scripts.

### 2026-09-05: fixed alongside the governance round

- `adapters/sql/catalog_ddl.py` now reads a **named** table constraint
  (`CONSTRAINT pk_x PRIMARY KEY (a, b)`) as a primary key. MySQL dumps normally
  write the bare `PRIMARY KEY (id)` the parser already handled; HSQLDB, Oracle
  and PostgreSQL dumps normally name it, and for those every column came back
  `pk: false`, silently, so join cardinality could never be inferred. Worker
  version `catalog-ddl/1` → `catalog-ddl/2`; output for both existing MySQL
  fixtures is byte-identical (checked).

### 2026-09-05: fixed by the identifier-identity round

- **SQL identifiers were matched case-sensitively** (the governance round's
  known defect, now fixed). jpetstore-6 declares `create table item (…)` and its mapper SQL says
  `FROM ITEM I`; the engine matched by exact string, so the catalog's `item` and
  the statements' `ITEM` became two different tables in one pack. Measured on
  that fixture, same 25 statements, same worker, the only difference being
  `--identifier-case`:

  | | before (`exact`) | after (`fold-lower`, the mysql default) |
  |---|---|---|
  | tables in the pack | 25 (13 + 12 upper-case stubs) | **13**, no stub |
  | column nodes | 139 (86 catalog + 53 invented) | **86** |
  | column facts | 53 | **231** |
  | unresolved column refs | 180 | **1** |
  | unresolved rate | 0.7725 | **0.0043** |
  | READS edges | 0 | **160** |
  | WRITES edges | 53 | **71** |
  | JOINS edges (ERD) | 0 | **6** (11 join predicates, 6 table pairs) |
  | dropped joins | 11 | **0** |
  | `qualify_failed` diagnostics | 12 | **0** |
  | `column_impact item.listprice` | "none" | **2 reading statements**, EXACT |

  The one column reference still unresolved is honest: `ORDER BY ORDERDATE` in
  `getOrdersByUsername` is a bare column with two tables in scope, so the engine
  records it rather than guessing which one owns it. Folding reduced the rate because
  the names genuinely match — a table the catalog does not have under the folded
  comparison is still `unresolved`, and `test/identifier_case.test.mjs` and
  `adapters/sql/test_lineage.py` both pin that.

  **mall did not move.** Its DDL and its SQL already agree in case, so the
  lineage stream is byte-identical before and after (checked directly, under
  both `exact` and `fold-lower`) and `test/mall_demo.test.mjs` still reproduced
  digest `8ac65658c1cc` from a fresh clone. (The next round moved that pack to
  `9e1874dd5f6c` for an unrelated reason, in *three defects earlier rounds found
  and deliberately left* below.) petclinic has no mapper XML at all —
  0 statements, so its SQL unresolved rate is 0/0 before and after; its
  persistence comes through the JPA bridge.

  Worker version `lineage/1` → `lineage/2`, and the identity rule is now part of
  the per-statement lineage shard key: the same SQL under two rules resolves to
  different tables and must not share a cached shard.
- One consequence worth knowing: the pack now names every table the way the
  CATALOG declares it. The identifier-identity round folded identifiers when
  matching FACTS and left a
  tool ARGUMENT compared byte for byte, so `table_usage ORDERS` (the spelling
  the SQL uses) was an unknown-table error on jpetstore while `table_usage
  orders` answered. The round after it closes that, below.

### 2026-09-05: three defects earlier rounds found and deliberately left

Three defects earlier rounds found, measured and deliberately left. Each was
measured on its own, so the effects do not mix.

- **A tool argument now names the same thing the SQL does.** `pack.meta`
  records `identifierCase` — the identity rule the lineage worker matched with
  — and the query layer resolves a `table=` / `column=` argument through the
  same fold (`src/core/name_resolve.mjs`). On jpetstore and on mall (both
  `fold-lower`), `table_usage ORDERS` and `table_usage orders` return the same
  statements and the same columns, and the folded call carries one
  `limits` line naming what was typed and what it resolved to — a match the
  caller did not literally ask for is never silent. `column_impact`,
  `endpoint_impact`, `flow`, `neighborhood` and `erd`'s focus take the same
  route; `search` was already case-insensitive. A name that folds onto TWO pack
  names stays unresolved and says which two. A name nothing matches keeps its
  `unknown-<kind>` code and gains "did you mean …" (case-insensitive equality
  first, then a bounded edit distance, at most three). `exact` folds nothing,
  and a pack built before this field existed carries no rule and therefore
  behaves exactly as it did — exact match, no fold.
- **The layering violation is gone, and a gate now watches it (I-3).**
  `src/core/overlay.mjs` imported `src/adapters/{sql,java}_bridge.mjs`, so the
  core depended on the lanes it is supposed to be independent of. The assembly
  both `analyze` and the overlay need is now `src/core/assemble.mjs`, which
  takes the bridges as INJECTED functions; `bin/cascade.mjs` — the layer allowed
  to know both sides — wires them once (`LANE_BRIDGES`). `src/core/` now imports
  nothing from `adapters/`, and `test/gates.test.mjs` fails the build on an
  import that does, including the `export … from` and dynamic-`import()`
  spellings. Behaviour is unchanged: the I-9 oracle, `overlay ⊆ full` and every
  mall golden stayed green, and the mall pack digest did not move on this
  change.
- **An endpoint node no longer keeps only the last controller that declared
  it.** A route two controllers declare is one node with two HANDLES edges;
  writing the node once per endpoint FACT let the second declaration overwrite
  the first, so `handler`, `file` and `line` named whichever declaration came
  last in the fact stream. On the `analyze` path that stream is sorted by
  handler fqn, so the winner was the HIGHEST one — while every view walks the
  LOWEST (`primaryHandlerOf`); on any path that does not sort, the attribute
  depended on arrival order. The node's own attributes are now derived from the
  PRIMARY handler, the same lowest-id rule `core/walks.mjs` applies to the
  edges, and a route with more than one handler carries all of them in
  `handlers`. Measured on mall: 7 of 239 endpoint nodes named a method the views
  did not walk (`GET /order/list` and six `/brand/*` routes, each naming the
  `mall-portal` or `mall-demo` copy while the views walked the admin one); after
  the fix, 0. The source preview and the viewer now open the
  method `flow`, `map` and `coupling` actually follow.

  This changes node attributes, so the mall pack moved: **`8ac65658c1cc` →
  `9e1874dd5f6c`**, re-derived three ways — a fresh clone through the documented
  no-flag path (`test/mall_demo.test.mjs`), an incremental run over the sibling
  checkout, and a `--cold` one. Every edge is byte-identical and exactly 7 nodes
  differ, so no other pinned number moved: the census (239 / 906 / 76 / 669 /
  10 784), `pms_product.price` (8 writing, 10 reading, 27 endpoints), the 7
  multi-handler routes and `coupling`'s whole-output byte hash all hold, each
  re-derived from the new pack.

### 2026-09-05: three follow-ups the MyBatis-Plus and route rounds left

- **The JPA bridge now applies the identifier fold.** `addJpaFacts` derived
  table and column names without the `identifierCase` rule the SQL lane and the
  MyBatis-Plus bridge already applied, so a project whose DDL is UPPER case
  (Oracle, HSQLDB, H2) got TWO nodes for one column — the DDL's `ID` and the
  naming strategy's `id` — and a column answer about either was missing half its
  statements. That is exactly what jeecg-boot's `sys_user_depart.id`/`.ID` did on
  the MyBatis-Plus side before that lane existed. The fold now lives in ONE
  helper,
  `graphSpellingIndex` (src/adapters/sql_bridge.mjs), used by both mapping
  bridges — a second copy would be a second chance to disagree with the worker.
  Latent, not observed on a fixture: petclinic's DDL is lower case, its rule is
  fold-lower, and its pack is byte-identical (`550ac700eb55`, stderr identical
  but for the receipt timestamp). The reproduction is
  `test/jpa_bridge.test.mjs`, which builds the split with an upper-case catalog
  and then shows it gone.
- **A raw SQL fragment inside a condition wrapper gets real lineage.**
  `apply / last / setSql / inSql / notInSql / exists / notExists / having` carry
  SQL TEXT that the MyBatis-Plus round could only report as `unresolved`. The op
  now says how the
  fragment is written into a statement (`apply` a `WHERE`, `setSql` an
  `UPDATE … SET`, `last` a tail), the `FROM` is the table the wrapper filters,
  MyBatis-Plus's `{0}` placeholder becomes `?`, and the result goes through the
  SAME `lineage.py`, catalog, dialect, identity rule and content-addressed shard
  cache as a mapper statement or a native `@Query`, under
  `<owner>.<method>#frag<n>`. What comes back is attached to the wrapper's
  statement with `evidence.fragmentOp`. A fragment that does not parse keeps the
  old note WITH its text; a fragment on a wrapper with no entity of its own is
  not written out at all and says so. jeecg-boot uses none of these ops — its
  pack is unchanged at `35b830ad52c8`, and the analyze output carries no
  fragment line — so the fixture is a synthetic project driven through the real
  CLI and both workers (`test/mp_fragments.test.mjs`):
  `apply("date_format(create_time,'%Y-%m') = {0}", ym)` makes the statement READ
  `create_time`, a column no method reference and no projection names.
- **Duplicated FQNs across modules are now COUNTED, and deliberately not
  resolved.** Measured before changing anything. jeecg-boot declares 3 FQNs in
  two files each (6 declarations, all three `@FeignClient` API interfaces that
  exist as a plain interface in `jeecg-system-local-api` and a client in
  `jeecg-system-cloud-api`); mall declares 0. 52 of jeecg-boot's 5 628 MAY_CALL
  edges touch one (36 by target owner, 16 by caller, 27 of them
  interface-dispatch); 0 HANDLES edges, 0 entity→table mappings and 0 of the 542
  MyBatis-Plus statements do. Reversing which of the two declarations the fact
  stream ends with — verified to actually change what `types` keeps — moves
  **zero edges and zero nodes**: a node id is the FQN, dispatch is keyed by FQN,
  and the one decision that depends on the declaring FILE (is this mapping a
  route we serve or a client call?) already goes through `typeAt(fqn, file)`
  from the route-classification round. So module-proximity resolution would add
  a rule with nothing behind
  it. What was missing was the disclosure: `laneStats.duplicateFqns` now carries
  the count, the declaration total, a breakdown by kind and the first 25 named,
  `overview` reports a `duplicate-types` gap, and `analyze` prints one line.
  Ingest-order independence is pinned by a test that feeds the two declarations
  both ways round and compares the whole edge set.

**Pinned numbers**: none moved. petclinic `550ac700eb55`, jeecg-boot
`35b830ad52c8` (8 533 nodes, 17 148 edges), mall `99141d55e969` (12 674 nodes,
19 269 edges) — each rebuilt from a fresh clone at its pinned commit.

### 2026-09-05: the MyBatis-Plus lane

Same fixture, **jeecgboot/JeecgBoot** (`7436405`), for the reason the
route-classification round's report ended on: the 735 routes that reached no statement did not reach one because
their chains ended at MyBatis-Plus's `IService`/`ServiceImpl`, whose
`list`/`page`/`count` are declared in the framework. This round is that
framework's lane. Every number below is hand-counted from the source over the
945 `.java` files in the 21 source roots `analyze` reads;
`test/jeecg.test.mjs` pins them and names the grep and the reconciliation that
produced each.

- **A new framework pack, `mybatis-plus`.** `cascade init` declares it when
  discovery sees `extends BaseMapper<` or `@TableName`; it is independent of
  `mybatis-xml`, and jeecg-boot has both. New profile keys
  `mybatisPlus.{namingStrategy, tablePrefix, logicDeleteValue,
  logicNotDeleteValue}`, wired through `PROFILE_KEY_CONSUMERS` — the first three
  consumed, the fourth recorded-not-acted and diagnosed when set.
- **Entities and columns, with the same naming discipline as the JPA lane.**
  `@TableName`/`@TableField`/`@TableId` are EXACT; a name derived by
  MyBatis-Plus's camelCase→under_score rule is EXACT when the profile declares
  the strategy and **HEURISTIC** when it does not, and the axis is then
  `degraded`, not shipped. `@TableField(exist = false)`, `static` and
  `transient` fields own no column, which is MyBatis-Plus's own rule. A catalog
  hit is recorded as `mpCatalogMatch` and never promotes a grade (I-1). jeecg:
  **64 entities, 50 of them with `@TableName`** (`grep -hoE
  '^[[:space:]]*@TableName'` → 50, in 50 files).
- **The entity is found through the generic bases transitively, with type
  substitution.** No project base-class name is hardcoded: jeecg-boot's own
  `JeecgServiceImpl<M extends BaseMapper<T>, T extends JeecgEntity> extends
  ServiceImpl<M, T>` resolves because `T` is substituted down the chain.
  jeecg: **64 mappers** (`extends BaseMapper<` → 65, minus one type-parameter
  BOUND in JeecgServiceImpl.java:17) and **118 service declarations**
  (`extends ServiceImpl<` 60 + `extends IService<` 59, minus one bound in
  `JeecgController<T, S extends IService<T>>`).
- **A statement per (owner, method) for the generic CRUD nobody wrote**,
  `statementType: "mp-builtin"`, with the access each verb performs — `insert`
  writes every mapped column (MyBatis-Plus writes the non-null ones, a run-time
  fact), `updateById` writes the non-id columns and reads the key, a `select`
  reads its wrapper's predicate columns *and* its projection. The statement is
  owned by the concrete `ServiceImpl` when the call went through the interface,
  reached by the dispatch edge the call lane already put there. A built-in the
  type declares ITSELF is not claimed (`builtinsOverridden`). jeecg: **542
  statements** (select 195, selectById 67, deleteById 74, insert 103,
  updateById 61, delete 29, update 8, saveOrUpdate 5).
- **Condition wrappers.** The worker gained a member-reference visitor and a
  chain flattener, and records per enclosing method what kind of wrapper was
  built, for which entity type, which ops with which method references and
  string literals, and where it was handed on. It decides nothing: `eq` is
  recorded as the op named `eq`. The bridge's op table is **total** — five
  readings (`column`, `columns`, `write`, `sql`, `structural`) and an
  `opsUninterpreted` count for anything outside it, named in the analyze output.
  jeecg: **444 wrappers, 831 ops, 0 uninterpreted**, 764 columns from method
  references and 165 from string literals.
- **RUNTIME_ONLY where the columns really are decided at run time.** jeecg
  builds 64 of its wrappers with `QueryGenerator.initQueryWrapper(object,
  request.getParameterMap())`, whose conditions come from the HTTP query string.
  The table stays a fact; the statement carries `columnsRuntimeOnly: true` with
  the reason; `overview` reports a `mp-columns-runtime-only` gap; and
  `column_impact` on **any** column of such a table adds a limit naming the
  statements and saying the list is a lower bound. **82 statements** on jeecg.
- **`@TableLogic` is a WRITE, not a delete.** MyBatis-Plus rewrites `delete*`
  into `UPDATE … SET del_flag = …`, so the row stays and the column is written;
  and it appends the flag to every query, so each one READS it
  (`evidence.implicitFilter`). jeecg: **6 entities carry it** (`@TableLogic`
  anchored → 7, minus SysUserSysDepPostModel.java:76, a result-map DTO no
  mapper names), **9 delete statements rewritten**, 47 implicit filter reads.
- **Node ids go through the SQL lane's identity fold.** `sys_user_depart` spells
  its key `ID` in jeecg's DDL while the entity derives `id`; without the fold
  that was two column nodes for one column and every answer about it was half an
  answer. Found by this round and fixed in it.
- **Two entities that map to ONE table are both named.** jeecg's sharding test
  module declares `@TableName("sys_log") ShardingSysLog` beside `SysLog`; the
  node lists both, sorted, at the weaker of the two grades, instead of naming
  whichever arrived last.
- **`baseMapper.` resolves.** `ServiceImpl<M, T>` declares `protected M
  baseMapper`, and 135 call sites in jeecg are spelled `baseMapper.selectList(…)`;
  the field's declared type is read off the `extends` clause IN THE SAME FILE, so
  no cross-file lookup and no invented field. (`grep -c 'baseMapper\.'` → 138:
  135 real calls, 2 in a class where `baseMapper` is a local variable, 1
  commented out.) No `field` record is emitted for it — the type does not declare
  it.
- **The census, the estimate and the viewer.** `pack.meta.axes` gains
  `mybatisPlus`; `overview.code` reports `mpEntities` / `mpBuiltinStatements` /
  `mpStatementsRuntimeOnlyColumns` and `overview.mybatisPlus` the wrapper
  numbers; `estimate` gains `mpStatementsResolved` and
  `mpWrapperColumnsResolved`; the Flow lane's statement chip shows `mp-builtin`
  and marks a row whose columns are decided at run time. The chip's colour is
  now read from the statement's own EXECUTES access instead of from its type
  name, which had been colouring every `derived`/`builtin`/`jpql` statement as a
  write.
- Worker `javafacts/5` → **`javafacts/6`** (new record kinds `mpEntity`,
  `mpMapper`, `mpService`, `mpWrapper`; the inherited `baseMapper` field).
  `buildHierarchyIndex` was extracted from `addJavaFacts` so the two bridges
  answer "which class implements this interface" and "what does this subclass
  bind `T` to" with one walk.

**What it bought, on jeecg-boot** (969 routes, unchanged): endpoints reaching a
statement **234 → 717**; statements 244 → 786; statements reached 164 → 743;
tables reached 40 → 72; columns reached 312 → 800. `column_impact
sys_user.username` goes from 37 rows (all mapper XML) to 51, and now carries the
runtime-only limit. mall (`99141d55e969`) and jshERP (`9fb602cd7758`) are
unchanged to the edge — neither uses MyBatis-Plus — and petclinic still passes.

### 2026-09-05: a mapping annotation is a handler, a client, or a contract

The fixture for this round is **jeecgboot/JeecgBoot** (`7436405`), the first
project in the suite that is not one deployable. Every number below is
hand-counted from its source; `test/jeecg.test.mjs` pins them and names the grep
that produced each.

- **A mapping annotation is no longer assumed to be a handler.** The lane now
  classifies each one by its ENCLOSING TYPE (`classifyRouteHolder`): a concrete
  `@RestController`/`@Controller` SERVES the route (HANDLES, EXACT, unchanged);
  a `@FeignClient` interface (or a class-level `@HttpExchange`) CALLS it
  (`symbol --CALLS_HTTP--> endpoint`, never HANDLES); a plain interface or
  abstract class DECLARES it as a route CONTRACT, whose handler is the concrete
  controller implementing it (HANDLES, SOUND_SET — a resolution by name and
  arity, not a definition), or, when nobody in the pack implements it, the
  contract method itself with `contractOnly: true` on the node. Anything else
  keeps today's behaviour, so the table stays total.
  Measured on jeecg-boot: **107 routes carried two handlers and now 0 do** — all
  107 paired one `@FeignClient` method with the `@RestController` that answers
  it (97 `ISysBaseAPI`/`SystemApiController`, 7 `IAiragBaseApi`, and one each
  for three cloud test clients), and jeecg-boot has no route declared by two
  concrete controllers. The 6 `@FeignClient` interfaces carry **116** mapped
  methods (`ISysBaseAPI` 100, `IAiragBaseApi` 7, `IOnlineBaseExtApi` 6, and 1
  each), and those are now 116 CALLS_HTTP edges: **107 SOUND_SET** (a route this
  pack also serves) and **9 UNRESOLVED** (6 to the `online` module, which is not
  in the open-source repository, and 3 real mismatches between the client's
  annotation and the controller's). An UNRESOLVED edge is below every mode's
  floor, so no walk follows it; the count is reported instead
  (`laneStats.httpCallsUnresolved`, `overview.gaps` → `http-calls-leaving-pack`).
  A route the pack only calls is `outbound: true` and is not counted as one of
  its endpoints: 978 endpoint nodes = 969 served + 9 outbound.
  Which deployable answers is not knowable from source and is never claimed —
  the service name and url ride as evidence, with `serviceLiteral` saying
  whether the source spelled a string or named a constant.

  Two files can declare the SAME fqn (jeecg-boot ships
  `org.jeecg.common.system.api.ISysBaseAPI` twice — a plain interface in
  `jeecg-system-local-api`, a `@FeignClient` with 100 mappings in
  `jeecg-system-cloud-api`, two modules never on one classpath). The classifier
  therefore looks a type up by fqn AND FILE, so one module's declaration cannot
  answer for another's.

- **The walks cross an internal HTTP hop.** `clientMethod --CALLS_HTTP-->
  route --HANDLES--> handler` is a real step of a real request. Walking DOWN it
  always was one; walking UP, `chain.mjs` excluded HANDLES, so an impact from a
  column stopped at the module boundary. It now takes the HANDLES step upwards
  on exactly the routes that are a hop (an endpoint with a CALLS_HTTP in-edge)
  and continues through the client method to ITS handlers. Every row reached
  that way carries `viaHttp: true` and `httpHops` — in `flow` both ways, `map`,
  `coupling`, `overview` reach, `endpoint_impact` and `changed_impact` — because
  the code on the far side is another deployable. The hop costs two real steps
  of depth, the weakest link still caps the row (a SOUND_SET CALLS_HTTP caps
  everything past it), and a strict walk crosses nothing.

- **Three call shapes the lane used to drop.** `this.m()` (rule
  `unqualified-enclosing` — one call, one rule), `super.m()` (rule
  `super-enclosing`, walking the `extends` chain to the first ancestor that
  DECLARES the method), and a receiver whose declared type is a TYPE PARAMETER
  of the enclosing type (rule `type-param-binding`: one edge per concrete
  binding a subclass makes, `evidence.boundAt` naming the binding site). The
  worker (`javafacts/4` → **`javafacts/5`**) now records each type's
  `typeParams`/`typeParamBounds`, its `extends`/`implements` type arguments, its
  `abstract` flag, its client annotation and the methods it declares.
  Measured on jeecg-boot: `super-enclosing` 30 resolved / 43 unresolved (73
  `super.` call sites in all; the 43 climb into framework classes this
  parse-only lane never sees), `type-param-binding` 168 edges, 0 unbound, and
  `unqualified-enclosing` rose 1330 → 1877.
  What that bought, measured by rebuilding the SAME fact set with each rule
  removed in turn: `endpointsReachingAStatement` **214 → 234**, and all 20 come
  from `this.m()`. `super.m()` and `type-param-binding` contribute **zero** —
  their chains end at MyBatis-Plus's `IService`/`ServiceImpl`, whose
  `list`/`page`/`count` are declared in the framework and are outside the pack.
  The edges are right; the honest number for what they added to reach is 0.

- **Discovery stopped shouting about translation files.** `dbconfig` no longer
  reads a `.properties`/`.yml` under `static/`, `public/`, `templates/`, `i18n/`
  or `locale*/`, nor a resource bundle by name (`messages*`, or a full `_xx_XX`
  locale suffix — a bare two-letter suffix is NOT enough, or `app_db.properties`
  would be lost). An unreadable line now produces ONE diagnostic per file, with
  a count, and only when the file also holds a datasource-shaped key. Measured
  on jeecg-boot: `cascade init` diagnostics **211 → 3**, `UNREADABLE_PROPERTY_LINE`
  **208 → 0**, and all **18** connection candidates still found.

  The mall pack moved for the `this.m()` rule alone: **`9e1874dd5f6c` →
  `99141d55e969`**. Exactly one number changed with it — MAY_CALL/SOUND_SET
  10 126 → 10 127 — re-derived FROM MALL'S SOURCE, not from the engine: its tree
  holds one `this.<method>(...)` call (`DynamicSecurityMetadataSource.java:44`,
  `this.loadDataSource()`) and two `super.<method>(...)` calls, both in
  `mall-mbg/CommentGenerator.java`, whose superclass is MyBatis Generator's
  `DefaultCommentGenerator` — outside the pack, so both are counted UNRESOLVED
  and add no edge. 12 674 nodes unchanged, 19 268 → 19 269 edges. Every other
  mall pin holds: the census, `pms_product.price` (8 / 10 / 27), the 7
  multi-handler routes, and `coupling`'s whole-output byte hash (which moved
  only by the one field the walk census gained, re-derived by deleting that key
  and reproducing the old hash byte for byte). petclinic is unchanged.

### Known defects — found, measured, NOT fixed

- **Invariant I-2 is not implemented.** An MCP response does not mark
  evidence text (SQL, comments, string literals) as untrusted data, so a comment
  in an analyzed repository written as an instruction reaches a consuming model
  unmarked. The other two defences against a hostile analyzed repository are
  implemented.
- **Invariant I-6 is only partly realized.** There is no single
  `loadFacts()` gate; what exists is a pack-digest check and a
  mixed-generation refusal in the incremental planner.
- **No coverage threshold is enforced.** `npm test` prints the table and a
  reviewer reads it.

The full state of all nine invariants, with the test file behind each, is in
[CONTRIBUTING.md](CONTRIBUTING.md#the-invariants-and-the-tests-that-hold-them).

---

## Where this stands — measured, and not

### Verified, with the number

Every number here was produced by running the thing on this machine during this
round, unless the line says otherwise.

| Claim | The number | How |
|---|---|---|
| Cold analysis (gate ≤15 min) | **24.0 s** on 400 tables / 3 800 endpoints / 6 000 Java files | `node scripts/make-synthetic-project.mjs --out DIR` then `cascade analyze --root DIR --cold` |
| Warm query p95 (gate ≤2 s) | **131 ms** over 100 calls (`flow`, `endpoint_impact`, `overview`, `map`) on that same pack | the tool catalog, called directly |
| Cold-process first answer (gate ≤5 s) | **394 ms** to read and digest-verify a 46.5 MB pack | same |
| Pack cost | 46.5 MB on disk, **113 MB** resident heap after load (2.4×) | `node --expose-gc` |
| I-9, incremental == cold | byte-equal packs after random seeded mutations | `test/incremental.test.mjs` |
| Overlay ⊆ full | the overlay omits nothing a full re-analysis of the same bytes finds | `test/overlay_integration.test.mjs` |
| **Determinism across paths** | a fresh clone of mall at a new absolute path, with a profile `init` wrote today, produced digest `99141d55e969` — the pinned one | `test/mall_demo.test.mjs` |
| The mall golden (SQL + Java) | 239 endpoints · 906 statements · 76 tables · 669 columns · 10 784 symbols; `pms_product.price` → 8 writing / 10 reading statements (EXACT) → 27 endpoints, 12 of them `/product/*` (SOUND_SET) | `test/mall_demo.test.mjs` |
| The same tree with its frontend | one `--web-src` at macrozheng/mall-admin-web adds 54 screens, 145 of 153 frontend call sites resolved onto routes, 121 exact and 64 candidate `RENDERS` edges, and 44 screens that reach a table; digest `7994e1a5fd22`, 13 032 nodes / 19 797 edges | `cascade analyze --root <mall> --web-src <mall-admin-web>/src` |
| The screen end, walked | `pms_product.price` reaches 12 screens (`screen_impact`), and `flow screen=/pms/product` walks 20 frontend functions → 10 endpoints → 35 services → 7 statements → 5 tables, 38 of its 79 links EXACT | the tool catalog, over the stdio server |
| A missing catalog is declared, not fatal | `--no-ddl` on the same tree: column facts 6 342 → 1 248, unresolved column references 396 → 5 135, and the pack declares `column: degraded` | `cascade analyze --root <mall> --no-ddl --out <dir>` |
| The petclinic golden (JPA) | 6 entities, 3 repositories, 6 statements, 0 unresolved | `test/petclinic.test.mjs` |
| The jpetstore golden (SQL) | 13 tables / 86 columns from HSQLDB DDL, 25 mapper statements over 7 files, 22 endpoints, 231 column facts (160 READS / 71 WRITES), 6 ERD relationships, unresolved rate 0.0043 | `test/jpetstore.test.mjs` |
| The generality gate | eleven pinned repositories read with nothing configured; the guarded counts are in `test/fixtures/generality-gate.baseline.json` and reproduced on [docs/measured.md](docs/measured.md) | `node scripts/generality-gate.mjs --fetch` |
| The identity rule, both implementations | the JavaScript and Python folds agree on 20 names × 3 rules × 11 dialects | `test/identifier_case.test.mjs` |
| Credentials are never stored | a fetch pins a snapshot and writes no credential anywhere; a fetch without `--yes` refuses to connect | `test/catalog_fetch.test.mjs` |
| The calibration tamper cases | 12 of them: a dropped fact set, an edited gate state, an edited pack, an edited receipt, an expired receipt, a flipped golden | `test/calibration_tamper.test.mjs` |
| Suites | 1 870 Node · 182 Python. One skip in each on this machine, both out loud and both naming their fix: the generality gate wants the pinned corpus cloned (about 1 GB), and the live-catalog container test wants the optional MySQL driver | `npm run test:quick`; `.venv/bin/python -m unittest discover -s adapters/sql -p 'test_*.py'` |

Two numbers on that list come from the earlier scale pass rather than from this
round, and are stated as such: the incremental run at that scale (**1.4 s** for
3 changed files, gate ≤2 min) and the overlay (**665 ms** for one file, gate
≤1 s; **1.2 s** for `impact` end to end, gate ≤3 s). They need the synthetic
project generated with `--git`, which this round did not re-run.

### NOT verified — and why

- **Live DB dialect queries.** The MySQL, PostgreSQL and Oracle catalog queries
  have unit tests against an injected cursor, and a container test that starts a
  real `mysql:8`. Neither has ever run against a live PostgreSQL or Oracle, and
  the container test has never run **here** — there is no Docker daemon on this
  machine, so `adapters/sql/test_catalog_live_container.py` is the one Python
  test that skips. The CI `db` job is the first real execution of any of it.
- **The viewer on a real GPU.** Nothing in this repository starts a browser. The
  page's logic is exercised in a `node:vm` against a DOM stub; the canvas mount,
  the WebGL context and the 3D renderer are unverified. 3D has only ever been
  seen under software rendering.
- **Any project larger than the synthetic one.** The scale numbers above come
  from a project this repository generates. It is real code that the real
  parsers really parse — but it is code written by a generator, with the shapes
  the generator knows to write. The largest *human* project measured is
  jeecgboot/JeecgBoot, at 969 endpoints, 839 statements, 177 tables and 2 092
  columns.
- **Every framework outside Spring MVC + MyBatis + MyBatis-Plus + JPA/Spring
  Data.** No other web framework, no other ORM, no other language. `init`
  reports what it has no lane for; it does not analyse it.
- **Every frontend outside Vue and React.** The web lane parses JavaScript,
  TypeScript, JSX, TSX and Vue single-file components, and recognises
  `vue-router` and `react-router` route declarations. An Angular or Svelte
  router yields no screen, and the axis says `not-shipped` rather than pretending
  the product has none.
- **A frontend whose menu arrives from the server on a route this engine cannot
  recognise as a menu.** Measured on jeecgboot/JeecgBoot: its business screens
  are fetched at run time from a route named after permissions, no spelling in
  the server-menu rule matches it, so its `screen` axis reads `shipped` and "19
  of 166 screens reach a table" reads as a shortfall rather than as a
  description. Adding that project's own spelling would be a rule that works on
  that project and nowhere else, so it is written down instead.
- **A wrapper prefix nobody declared.** Where the frontend's URL prefix is not
  stated anywhere in the source, the engine matches candidates against the routes
  and takes the best fit. That is a guess, every edge through it is `HEURISTIC`,
  and the `web` axis is `degraded` until `gatewayRoutes` declares the mapping.
  Two of the eleven gate repositories are in that state.
- **Any dialect but MySQL and the ANSI parser, in the analysis path.** mall is
  parsed as `mysql`. jpetstore has been analysed both ways — as `mysql` (the
  assumed default) and as `hsqldb`, which routes to SQLGlot's ANSI parser — and
  the two produce the same pack digest, so the ANSI path is exercised. The
  profile also accepts `postgres`, `oracle` and `h2`; no golden runs those, and
  their identifier rules are unit-tested rather than measured on a real schema.
- **The README badge.** There is none, because the repository has no remote yet;
  a badge pointing at a workflow nobody can fetch is worse than no badge. It
  goes in when the remote does.

[Unreleased]: https://github.com/alexsoft-hq/Cascade/compare/v0.8.1...HEAD
[0.8.1]: https://github.com/alexsoft-hq/Cascade/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/alexsoft-hq/Cascade/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/alexsoft-hq/Cascade/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/alexsoft-hq/Cascade/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/alexsoft-hq/Cascade/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/alexsoft-hq/Cascade/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/alexsoft-hq/Cascade/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/alexsoft-hq/Cascade/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/alexsoft-hq/Cascade/releases/tag/v0.1.0
