# What was measured, and what was not

Every number in this document was produced by running the engine, and every row
names the command that produces it again. The second half of the page, the list
of what is **not** verified, matters more than the first: a tool whose only
durable difference is honesty has to be honest about its own evidence.

## The generality gate

`scripts/generality-gate.mjs` runs this engine, unchanged and with **no
per-project configuration**, over a pinned corpus of real repositories nobody
here wrote it for, and prints what it reached.

The engine's own tests prove that each rule does what it says on a fixture
chosen to exercise it. They cannot tell you whether the SET of rules adds up to
something that works on a repository nobody here has read. That question has one
honest answer, which is to run it and count, and the answer is only worth
anything if it repeats: the same commits, the same flags, the same numbers, so a
change that quietly loses a DAO layer shows up as a smaller number rather than
as nothing at all.

```bash
node scripts/generality-gate.mjs --fetch            # clone or check out every pin, then run
node scripts/generality-gate.mjs --fetch --no-run   # clone only
node scripts/generality-gate.mjs                    # run over whatever is cloned
node scripts/generality-gate.mjs --only mall,litemall
node scripts/generality-gate.mjs --accept           # rewrite the baseline, printing the diff
```

`test/generality_gate.test.mjs` compares the result against
`test/fixtures/generality-gate.baseline.json` and **fails when a repository
reaches less than it did**. A rise changes nothing until somebody runs
`--accept`: a number that improves silently is a number nobody checked. The
clones live under the cache directory, about 1 GB in all, never inside this
repository, and each run gets its own registry so the gate cannot write into
yours.

### The corpus, and what it reached

Six counts are guarded. Five of them are floors, and a drop in any fails the
suite.

| Repository | Pinned at | Endpoints reaching a statement | Tables reached | Columns reached | Frontend calls resolved | Screens reaching a table | Endpoint to column pairs |
|---|---|---|---|---|---|---|---|
| [jeecgboot/JeecgBoot](https://github.com/jeecgboot/JeecgBoot) | `74364054` | 744 / 969 | 73 / 177 | 836 / 2092 | 562 / 963 | 25 / 181 | 15997 |
| [jishenghua/JSH_ERP](https://github.com/jishenghua/JSH_ERP) | `ad6cf886` | 330 / 339 | 32 / 32 | 409 / 413 | 165 / 221 | 0 / 7 | 13179 |
| [apache/dolphinscheduler](https://github.com/apache/dolphinscheduler) | `499fd068` | 204 / 239 | 42 / 65 | 457 / 622 | 219 / 233 | 0 / 44 | 6216 |
| [macrozheng/mall](https://github.com/macrozheng/mall) + [mall-admin-web](https://github.com/macrozheng/mall-admin-web) | `0504e86b` + `81fc17e5` | 205 / 239 | 49 / 76 | 461 / 669 | 145 / 153 | 44 / 54 | 3868 |
| [linlinjava/litemall](https://github.com/linlinjava/litemall) | `a1ef964a` | 198 / 219 | 34 / 34 | 376 / 376 | 172 / 191 | 40 / 89 | 4223 |
| [yangzongzhuan/RuoYi-Vue](https://github.com/yangzongzhuan/RuoYi-Vue) + [RuoYi-Vue3](https://github.com/yangzongzhuan/RuoYi-Vue3) | `13db1fce` + `838965c5` | 123 / 147 | 22 / 33 | 224 / 305 | 122 / 142 | 8 / 21 | 1613 |
| [jeequan/jeepay](https://github.com/jeequan/jeepay) | `ba371119` | 126 / 134 | 22 / 23 | 302 / 314 | 0 / 0 | 0 / 5 | 3554 |
| [xuxueli/xxl-job](https://github.com/xuxueli/xxl-job) | `e74c784f` | 31 / 42 | 7 / 8 | 70 / 71 | 24 / 31 | 6 / 11 | 528 |
| [mybatis/jpetstore-6](https://github.com/mybatis/jpetstore-6) | `ebb36b39` | 11 / 22 | 12 / 13 | 77 / 86 | 52 / 53 | 16 / 16 | 243 |
| [spring-projects/spring-petclinic](https://github.com/spring-projects/spring-petclinic) | `818c4136` | 15 / 17 | 7 / 7 | 24 / 24 | 12 / 13 | 3 / 8 | 196 |
| [spring-petclinic-microservices](https://github.com/spring-petclinic/spring-petclinic-microservices) | `3858f9c6` | 13 / 15 | 7 / 7 | 24 / 24 | 14 / 14 | 8 / 9 | 99 |

Six more repositories joined this corpus in RM55 and are measured in [their own
section](#the-korean-market-held-out-first), which keeps the measurement taken
BEFORE any rule was written for them beside the one after.

The last column is the sixth, and it is guarded the other way up. It adds up,
over every endpoint, how many distinct columns that one endpoint reaches, and a
rise of more than five percent fails the suite. It is here because the five
floors are all union counts over the whole project, and a union count cannot see
reach that smears sideways: when one generic base method resolved in every
subclass at once, jeecg carried 9,400 false endpoint-to-column pairs, not one of
them naming a column some other endpoint did not already reach on its own. Every
floor above stayed exactly where it is written, and the gate stayed green. The
pair sum is the number that moved, 25,397 down to 15,997 when the rule was
fixed, and it is guarded now so the next one fails instead.

### The axes each entry declared

The other half of a gate run is what each pack said about itself before anybody
asked it a question.

| Repository | catalog | statements | jpa | mybatisPlus | column | code | web | screen |
|---|---|---|---|---|---|---|---|---|
| jeecg-boot | shipped | shipped | not-shipped | degraded | shipped | shipped | shipped | shipped |
| jsh-erp | shipped | shipped | not-shipped | not-shipped | shipped | shipped | degraded | shipped |
| dolphinscheduler | shipped | shipped | not-shipped | degraded | shipped | shipped | shipped | degraded |
| mall | shipped | shipped | not-shipped | not-shipped | shipped | shipped | shipped | shipped |
| litemall | shipped | shipped | not-shipped | not-shipped | shipped | shipped | degraded | shipped |
| ruoyi-vue | shipped | shipped | not-shipped | not-shipped | shipped | shipped | shipped | degraded |
| jeepay | shipped | shipped | not-shipped | degraded | shipped | shipped | not-shipped | not-shipped |
| xxl-job | shipped | shipped | not-shipped | not-shipped | shipped | shipped | shipped | degraded |
| jpetstore-6 | shipped | shipped | not-shipped | not-shipped | shipped | shipped | shipped | shipped |
| spring-petclinic | shipped | not-shipped | degraded | not-shipped | degraded | shipped | shipped | degraded |
| petclinic-ms | shipped | not-shipped | degraded | not-shipped | degraded | shipped | shipped | shipped |

`degraded` on `mybatisPlus` there is the naming strategy: no profile in the
corpus declares one, so the engine assumes MyBatis-Plus's own default, grades
every name it derived that way `HEURISTIC`, and says so. `degraded` on `web` is
the frontend prefix: nothing in the source states it, so the engine matched
candidates against the routes and took the best fit, which is a guess and is
graded as one. `degraded` on `screen` is a router the server fills in at run
time, which means the screens in the source are not the screens the product has.

### How to read these numbers

"204 of 239 endpoints reach a statement" says the engine connected 204 chains.
Whether the other 35 touch no database at all (a login, a file upload, a health
check) or whether the engine lost one of their calls is a question only reading
them answers, and the round that adds a repository to this table is the round
that reads them. It is not a benchmark and it is not a claim of correctness.

Three of those frontend numbers are new in RM47, and none of them came from a
flag. The petclinic gateway ships its frontend as `<script src>` tags with no
`package.json` anywhere: 22 files, nine screens and thirteen `$http` calls that
the lane refused to open until this round, so both of its frontend columns said
"no frontend read". `cascade init` now calls a directory of frontend sources the
tree says it serves a web root and writes it into the profile. xxl-job gains a
web lane over 19 loose scripts and reads two call sites out of them, neither
resolving to a route it serves, which is why its `web` axis is `degraded` rather
than `shipped`; jeecg-boot picks up five more call sites the same way, none of
them resolving either. jeepay is the case that stays where it was on purpose:
its `static/cashier/js` is a webpack build, and a `.js` with a `.js.map` beside
it is output rather than a frontend somebody keeps here. See
[the web lane](setup/web-lane.md#a-frontend-with-no-packagejson).

Four of them are new in RM48, and none of them came from a flag either. Three
of these projects have no frontend router at all: a `@Controller` returns a view
name, a template engine renders it, and the page's own `<form>`, its links and
its inline `<script>` are what talk to the backend. spring-petclinic, xxl-job
and jpetstore-6 had **zero screens** for exactly that reason, and now have 8, 11
and 16. jpetstore's 20 JSP pages yield 52 resolved calls out of 53 and every one
of its 16 pages reaches a table, which is why it is the one project here whose
`screen` axis reads `shipped`. jeecg-boot gains 15 pages beside the 166 screens
its Vue frontend's router declares, and jeepay 5 payment pages it had none of.

Ten of jpetstore's sixteen page names, and five of petclinic's eight, are not
literals at the return statement at all: they are a `static final String` the
controller declares (`return VIEWS_OWNER_CREATE_OR_UPDATE_FORM;`) or a private
method of the same class whose returns are literals (petclinic's
`addPaginationModel`). Both are read out of ONE file, so both are EXACT like any
other literal. What is still not read is a name that would need another file or
a data-flow answer: 2 of petclinic's returns (`"redirect:/owners/" +
owner.getId()`) and 2 of xxl-job's, which is why those two read `degraded`.

One entry is worth reading as a limit rather than as a score. jeecg-boot
declares 173 routes, 87 of them the framework's own demo pages, and fetches
every business screen at run time from a route named after **permissions**
rather than after menus. No spelling in the server-menu rule matches it, so its
`screen` axis reads `shipped` and "19 of 166 screens reach a table" reads as a
shortfall rather than as a description of a product whose screens are mostly not
in its source. Adding that project's own spelling to the rule would be a rule
that works on that project and nowhere else, so the table stays generic and this
is written down instead.

## The Korean market, held out first

The eleven repositories above are the frameworks the world writes in. They are
not the market this product is for. So RM55 cloned the public repositories that
are — eGovFrame, which every Korean public sector project is required to build
on, a Nexacro client over an eGovFrame backend, and one modern Korean OSS as a
control — and **measured them before writing a line of code for them**. That
first measurement is kept here beside the one after, so anyone can see which
numbers the round moved and which it did not.

### The first measurement, before any rule was written

| Repository | Pinned at | Endpoints reaching a statement | Tables reached | Columns reached | Frontend calls resolved | Screens reaching a table | Endpoint to column pairs |
|---|---|---|---|---|---|---|---|
| [egovframe-common-components](https://github.com/eGovFramework/egovframe-common-components) | `a88a3e31` | **0 / 1193** | 0 / 184 | 0 / 1956 | 0 / 13 | 0 / 1 | 0 |
| [egovframe-enterprise-business-template](https://github.com/eGovFramework/egovframe-enterprise-business-template) | `cfccbe89` | **0 / 219** | 0 / 35 | 0 / 288 | 0 / 4 | 0 / 0 | 0 |
| [egovframe-msa-edu](https://github.com/eGovFramework/egovframe-msa-edu) | `777f697c` | 90 / 163 | 20 / 25 | 191 / 270 | 2 / 217 | 0 / 0 | 394 |
| [egovframe-web-sample](https://github.com/eGovFramework/egovframe-web-sample) | `8f37555e` | 5 / 6 | 1 / 1 | 5 / 5 | 0 / 0 | 0 / 0 | 5 |
| [nexacro-sample-egov](https://github.com/nexacro-spring/nexacro-sample-egov) | `deb90f90` | 6 / 21 | 2 / 5 | 9 / 46 | 0 / 0 | 0 / 0 | 27 |
| [naver/ngrinder](https://github.com/naver/ngrinder) | `2a6da299` | 30 / 124 | 7 / 9 | 92 / 114 | 66 / 77 | 0 / 19 | 900 |

Two of those rows are the finding. 219 routes and 205 statements, 1,193 routes
and 1,256 statements, and **not one edge between them**: nothing a route reached
ended at a table. The product was useless on eGovFrame, and the causes were
three, each verified by reading the trees:

1. **Statements are called by their string id.** eGovFrame DAOs extend a session
   base and write `selectList("CmmnDetailCodeManageDAO.selectCmmnDetailCodeList",
   vo)`. There is no mapper interface anywhere, and the engine bound a statement
   only through one.
2. **The view resolver is a bean in an XML.** 92 and 747 JSPs, and no template
   root, because the prefix was in `egov-com-servlet.xml` rather than in
   `application.yml`.
3. **The DDL is one file per vendor.** Seven of them, all read at once.

### The same six, after

| Repository | Endpoints reaching a statement | Tables reached | Columns reached | Frontend calls resolved | Screens reaching a table | Endpoint to column pairs | Wall |
|---|---|---|---|---|---|---|---|
| egovframe-common-components | **999 / 1193** | 165 / 179 | 1640 / 1818 | 765 / 811 | 470 / 657 | 9568 | 50 s |
| egovframe-enterprise-business-template | **163 / 219** | 30 / 35 | 210 / 288 | 122 / 135 | 55 / 84 | 1889 | 4 s |
| egovframe-msa-edu | 90 / 163 | 20 / 25 | 191 / 270 | 2 / 217 | 0 / 0 | 394 | 1 s |
| egovframe-web-sample | 5 / 6 | 1 / 1 | 5 / 5 | 0 / 0 | 0 / 2 | 5 | 1 s |
| nexacro-sample-egov | **2 / 21** | 2 / 5 | 9 / 46 | 0 / 0 | 0 / 0 | 9 | 1 s |
| ngrinder | 30 / 124 | 7 / 9 | 92 / 114 | 66 / 77 | 0 / 19 | 900 | 1 s |

**The one number that went DOWN is the one worth reading.** nexacro-sample-egov
fell from 6 endpoints reaching a statement to 2, and its pair count from 27 to 9,
while the tables and columns it reaches did not move at all. That project
declares one `SampleService` interface with two implementations — one over
iBATIS, one over MyBatis — and one `LargeDataService` with three. Every
controller reached all of them through the interface, so four routes claimed to
run MyBatis statements that their own `@Resource(name = "sampleService")` says
they never touch. Reading the bean name removed exactly those four, and the two
that remain (`/sampleMybatisSelectVO.do`, `/sampleMybatisLargeData.do`) are the
two routes wired to the MyBatis implementation. Verified by running the same
commit with the rule switched off and listing both sets.

msa-edu and ngrinder did not move by one number, which is the other half of the
result: neither has a mapper XML, an XML view resolver or a vendor DDL tree, so
none of the three rules had anything to fire on. Their frontends (two Next.js
applications and a Nexacro client) are still unread, and that is the next round.

The eleven repositories above this section did not move by one number either.


### And the same six after the rest of the Korean stack (RM56)

RM55 fixed what a route reaches; it left the frontends and half the SQL. RM56
took those: one vendor's mapper XML, iBATIS 2 in the SQL lane, a Nexacro client
in the web lane, and Next.js file routing.

| Repository | Endpoints reaching a statement | Tables reached | Columns reached | Frontend calls resolved | Screens reaching a table | Endpoint to column pairs | Wall |
|---|---|---|---|---|---|---|---|
| egovframe-common-components | 999 / 1193 | 165 / 179 | **1680 / 1862** | 765 / 811 | 470 / 657 | 9647 | 22 s |
| egovframe-enterprise-business-template | 163 / 219 | 30 / 35 | **218 / 288** | 122 / 135 | 55 / 84 | 2099 | 2 s |
| egovframe-msa-edu | 90 / 163 | 20 / 25 | 191 / 270 | 2 / 217 | **0 / 56** | 394 | 1 s |
| egovframe-web-sample | 5 / 6 | 1 / 1 | 5 / 5 | 0 / 0 | 0 / 2 | 5 | 0 s |
| nexacro-sample-egov | **10 / 21** | **5 / 5** | **46 / 46** | **7 / 7** | **4 / 30** | 100 | 1 s |
| ngrinder | 30 / 124 | 7 / 9 | 92 / 114 | 66 / 77 | 0 / 19 | 900 | 1 s |

Read row by row:

- **nexacro-sample-egov** is the round in one line. Its persistence is iBATIS 2
  and its frontend is Nexacro, and before this round the engine read neither: 3
  statements, 2 routes reaching one, no screen at all. Now 24 statements (22 of
  them iBATIS), 10 of 21 routes, every table and every column the schema
  declares, 30 forms read as screens, and all 7 of their `transaction(…)` calls
  matched to a `.do` route.
- **the business template** ships 27 mappers seven times over. Reading one
  vendor's copies took 189 mapper files to 27 and **47 statements failing to
  parse to 1**; the one that is left is a `<isNotEmpty>` branch structure whose
  flattened form holds two `SELECT`s end to end
  (`ConectStatsDAO.selectConectStats`), which is the flattener's own limit and
  not a vendor's. The statement count falls 205 → 201 because four
  `loginDAO.*` statements are **commented out in the MySQL copy** and live only
  in the six this project does not run: statements that do not exist for this
  deployment. Columns reached rise 210 → 218 for the same reason the parse
  failures fell.
- **the common components** ship 1,224 mapper files the same way: 1,256
  statements → 1,241, and 1,818 known columns → 1,862, because the statements
  that now parse name columns the run could not see before. One number went
  down: statements reached 1,136 → 1,135, the single statement among the fifteen
  removed ones that a DAO really called and that exists only in another vendor's
  copy.
- **msa-edu** gets its screens: 56, from 62 file-tree page declarations across
  two Next.js frontends, with 9 files under `pages/api` counted and read as the
  server handlers they are. Its call resolution does **not** move, and the reason
  is not this round's: its frontend calls `/portal-service/api/v1/…` through an
  API gateway whose `RewritePath` filter uses a named capture group, which the
  gateway-route reader refuses with `GATEWAY_ROUTE_UNREADABLE`. Until that
  prefix is read, the calls name paths no route in the pack serves.
- **egovframe-web-sample** and **ngrinder** do not move by one number: neither
  ships a vendor mapper set, a `<sqlMap>`, a Nexacro form or a `pages/` tree, so
  none of the four rules had anything to fire on.

The eleven repositories above this section do not move by one number, all
sixteen pack digests are identical, and 3,028 recorded answers are byte-identical.

Two entries trip the **ceiling** the gate guards the other way up:
`endpointColumnPairs` rises 1,889 → 2,099 on the business template and 9 → 100
on the Nexacro sample. Both are the same cause as the rises above — statements
that now parse, and a client whose screens now reach tables — rather than reach
smearing sideways, and both are on the held-out six.

### What the after-run left on the table

- **56 of 219** and **194 of 1193** routes still reach no statement. On the
  business template, 52 of the 246 statement-id call sites name a statement no
  mapper XML in that repository declares (`BBSAddedOptionsDAO.insert…`,
  `BBSLoneMasterDAO.select…`): a component whose Java is shipped and whose SQL is
  not. They are listed by name in `laneStats.statementIds.unknownSamples` rather
  than invented.
- **the mapper XML is shipped once per vendor too.** RM56 fixed this half: see
  the round above, and `docs/setup/sql-lane.md`.
- **msa-edu's frontend calls still reach no route.** 2 of 217, and the cause is
  its API gateway: `RewritePath=/portal-service/(?<segment>.*), /$\{segment}`
  uses a named capture group the gateway-route reader refuses
  (`GATEWAY_ROUTE_UNREADABLE`), so nothing strips the service prefix off the
  calls. That is a gateway rule, not a frontend one, and it is untouched.

### And the same six after the two defects the MSA template exposed (RM57)

RM56 read msa-edu's 56 screens and left its calls at 2 of 217. The two causes
were both general, and neither was Korean: a gateway rewrite written the way
Spring's own reference writes it, and one hop between a page and the module its
API calls live in.

| Repository | Endpoints reaching a statement | Tables reached | Columns reached | Frontend calls resolved | Screens reaching a table | Endpoint to column pairs | Wall |
|---|---|---|---|---|---|---|---|
| egovframe-common-components | 999 / 1193 | 165 / 179 | 1680 / 1862 | 765 / 811 | 470 / 657 | 9647 | 21 s |
| egovframe-enterprise-business-template | 163 / 219 | 30 / 35 | 218 / 288 | 122 / 135 | 55 / 84 | 2099 | 2 s |
| egovframe-msa-edu | 90 / 163 | 20 / 25 | 191 / 270 | **23 / 217** | **12 / 56** | 394 | 1 s |
| egovframe-web-sample | 5 / 6 | 1 / 1 | 5 / 5 | 0 / 0 | 0 / 2 | 5 | 1 s |
| nexacro-sample-egov | 10 / 21 | 5 / 5 | 46 / 46 | 7 / 7 | 4 / 30 | 100 | 1 s |
| ngrinder | 30 / 124 | 7 / 9 | 92 / 114 | 66 / 77 | 0 / 19 | 900 | 1 s |

Only msa-edu moves, and it moves twice.

- **The gateway prefix is now read.** The six routes carry
  `RewritePath=/portal-service/(?<segment>.*), /$\{segment}` and its five
  siblings, and they were refused for a reason the round before got wrong. The
  replacement was already read: what was not is that `Path=/portal-service/**`
  names the prefix `/portal-service` while the pattern writes
  `/portal-service/`, prefix plus separator, so the pattern did not match the
  prefix and the reader said so. Both spellings are the same prefix rule, and
  reading them alike took the six routes from a `GATEWAY_ROUTE_UNREADABLE`
  diagnostic each to six entries with the service each forwards to, and calls
  resolved from **2 of 217 to 23**.
- **A page reaches the module its API calls live in.** The pages import
  `@service` and write `contentService.get(id)`; the calls are in
  `service/*.ts`, in an exported object of functions. The `.ts` was never the
  problem — the resolver already tried `.ts` first, the `@service` alias already
  resolved and `.ts` modules already carried CALLS edges. What was missing was
  the member: the bridge read `svc.method()` on an imported object as a call to
  nothing it had read, because the key alone (`get`) does not say which object
  it belongs to. The worker now records the owner, and the bridge matches on it:
  **7 CALLS edges to 100**, 31 RENDERS to 81, and screens reaching a table from
  **0 of 56 to 12**.
- **The screen axis went from `shipped` to `degraded` on msa-edu, and that is
  the honest direction.** Its call to `/api/v1/menus` now matches a route, so
  the run can see that the app fetches part of its menu at run time and says
  that the 62 declared screens are not the whole product. Before the gateway
  fix it could not see that and said nothing.
- **The other five do not move by one number**, and neither do the eleven
  repositories above this section: sixteen pack digests identical, 3,028
  recorded answers byte-identical. The gate's own jeecg-boot entry gains 14
  symbol nodes and 17 CALLS edges from the member rule (`rules.duplicateCheckRule`,
  `formApi.doQueryField`), which are hops that were always there; not one
  guarded number moves.

The round trip, end to end, on the `/content/{id}` screen: RENDERS (EXACT, the
route declaration names the component) to `ContentItem`, CALLS (SOUND_SET, the
member `contentService.save` through an `export *` barrel) to `Content.ts#save`,
CALLS_HTTP (SOUND_SET, axios, the declared gateway prefix taking
`/portal-service` off the front) to `POST /api/v1/contents`, HANDLES (EXACT) to
`ContentApiController#save`, two MAY_CALL hops to `ContentRepository#save`,
IMPLEMENTS_STMT (EXACT), and the table `content`, written.

#### What this round left on the table

**A URL built on a module constant is still nothing but holes.** 73 of msa-edu's
217 call sites resolve to a template like `{*}/{*}`, because
`` axios.get(`${POSTS_URL}/${id}`) `` records the leading `${POSTS_URL}` as a
hole. The worker names the hole (`base: "POSTS_URL"`) and knows the constant's
value in the same file, but nothing substitutes it, so the path names no route
and the walk stops at the API function. That is why the portal's own
`/board/{skin}/{board}/view/{id}` reaches five service functions and no
endpoint. It is a general gap in the URL reader, not a gateway or a member rule,
and it is untouched here.

## The goldens

Three real projects, each pinned to a commit and checked end to end.

```bash
node --test test/mall_demo.test.mjs        # the MyBatis + Spring MVC golden
node --test test/jpetstore.test.mjs        # the HSQLDB + MyBatis golden
node --test test/petclinic.test.mjs        # the JPA golden
```

Each skips **out loud** without its fixture, naming both the fixture and the
command that produces it. CI clones all three at pinned commits and **fails if
any of those tests skips**, because a permanent self-omission on a fresh clone
is a defect rather than a pass.

### mall

Built from a fresh clone at a new absolute path, through the documented no-flag
path, with a profile `cascade init` wrote on the spot:

| What | The number |
|---|---|
| pack | 12674 nodes, 19269 edges, lanes `[sql,java]`, digest `99141d55e969` |
| census | 239 endpoints, 906 mapper statements, 76 tables, 669 columns, 10784 symbols |
| reach | 205 of 239 endpoints reach a statement, 208 statements, 49 tables, 461 columns |
| `pms_product.price` | 18 statements, 8 writing and 10 reading, all `EXACT` |
| the same column, upward | 27 endpoints, 12 of them under `/product/*`, all `SOUND_SET` |
| ERD | 27 relationships over 76 tables, joining 32 of them |
| transactions | 35 `@Transactional` boundaries, the largest reaching 15 tables |
| coupling | 32 API groups, 22 of them participating, 61 coupled pairs, 267 coupled columns |

With its Vue admin frontend added by one `--web-src` flag, the same tree becomes
13032 nodes and 19797 edges, digest `7994e1a5fd22`, and adds 54 screens, 145
resolved frontend calls out of 153, and 44 screens that reach a table.

### jpetstore-6

| What | The number |
|---|---|
| census | 22 endpoints, 25 mapper statements, 13 tables, 86 columns |
| reach | 11 of 22 endpoints reach a statement, 12 tables, 77 columns |
| pages | 20 JSP templates, 16 of them a controller names, 52 of 53 call sites resolved |

Its schema is HSQLDB, which routes to sqlglot's ANSI parser rather than to a
dialect parser of its own, so this golden is what exercises that path. It is
also the plainest server-rendered application in the corpus: not one line of
JavaScript, and every screen it has is a JSP file a `@Controller` named.

### spring-petclinic

| What | The number |
|---|---|
| census | 17 endpoints, 6 statements, 7 tables, 24 columns |
| reach | 15 of 17 endpoints reach a statement, 7 tables, 24 columns |
| pages | 12 Thymeleaf templates, 8 of them a controller names |

It has no mapper XML at all: every statement in it is one the JPA bridge derived
from an entity mapping, a derived query name or a `@Query`.

It is also the project a real OpenTelemetry agent capture is kept for
(`test/fixtures/otel/petclinic-agent.log`, ten routes), and that recording is
what moved these numbers. Of the ten routes it observed, six read tables the pack
did not name, for two reasons: the JPA lane stopped at the entity the repository
method names instead of following the eager associations that come back with it,
and nothing in the graph led to a `@ModelAttribute` method, which is where two of
those routes load their owner. Both are read now, and all ten routes score. The
two routes the pack still answers nothing for are the welcome page and the crash
page, which run no SQL.

## The incremental oracle

The claim that a reused analysis equals a fresh one is a test rather than a
promise. `test/incremental.test.mjs` builds a synthetic Spring, MyBatis and
MySQL project inside a git repository, mutates a random subset of its files each
round with a seeded PRNG, and requires the incremental pack to equal a cold pack
**byte for byte**.

```bash
node --test test/incremental.test.mjs
node --test test/overlay_integration.test.mjs
```

The second one holds the other half: the working-tree overlay may
over-approximate, and it may **not** omit. It compares the overlay against a full
re-analysis of the same bytes and fails on anything the overlay missed.

## Determinism, tamper cases and credentials

| Claim | How it is held |
|---|---|
| the same commit, catalog, engine and profile produce the same pack digest on any machine | `test/mall_demo.test.mjs` rebuilds mall from a fresh clone at a different absolute path and compares the digest |
| an edited pack, receipt, fact set or gate state is refused rather than used | `test/calibration_tamper.test.mjs`, twelve cases including a dropped fact set, an expired receipt and a flipped golden |
| no credential is ever written to `.cascade/`, the pack, the receipt, the registry or a log | `test/catalog_fetch.test.mjs` runs a fetch end to end and greps every written file and both captured streams |
| `catalog fetch` refuses to connect without `--yes` | the same test |
| the JavaScript and Python identifier folds agree | `test/identifier_case.test.mjs`, 20 names by 3 rules by 11 dialects, running both implementations |

## NOT verified, and why

These are not "probably fine".

- **Live PostgreSQL and Oracle catalog queries.** They have unit tests against
  an injected cursor and nothing else. The MySQL container test starts a real
  `mysql:8`, but it has never run on the machine this was built on, so CI's
  `db` job is the first real execution of any of it.
- **The viewer on a real GPU.** Nothing in this repository starts a browser. The
  page's logic is exercised in a `node:vm` against a DOM stub; the canvas mount,
  the WebGL context and the 3D renderer are unverified, and 3D has only ever
  been seen under software rendering.
- **Any project larger than the generated one.** The scale numbers in the
  changelog come from a project this repository generates. It is real code that
  the real parsers really parse, but it is code written by a generator, with the
  shapes the generator knows to write. The largest **human** project measured is
  jeecg-boot, at 969 endpoints and 2092 columns.
- **Every framework outside Spring MVC, MyBatis, MyBatis-Plus and JPA or Spring
  Data.** No other web framework, no other ORM, no other language. `cascade
  init` reports what it has no lane for; it does not analyse it.
- **Any dialect but MySQL and the ANSI parser, in the analysis path.** mall is
  parsed as `mysql`. jpetstore has been analysed both ways, as `mysql` and as
  `hsqldb`, and the two produce the same pack digest, so the ANSI path is
  exercised. The profile also accepts `postgres`, `oracle` and `h2`; no golden
  runs those, and their identifier rules are unit-tested rather than measured on
  a real schema.
- **Two of the nine invariants are not fully closed**, and
  [CONTRIBUTING.md](../CONTRIBUTING.md#the-invariants-and-the-tests-that-hold-them)
  says which and how far. In short: an MCP response does not yet mark evidence
  text as untrusted data, so a comment in an analyzed repository written as an
  instruction reaches a consuming model unmarked; and there is no single
  publish gate, only a pack-digest check and a mixed-generation refusal in the
  incremental planner.
- **No coverage threshold is enforced.** `npm test` prints the table and a
  reviewer reads it.

The changelog carries the same two lists round by round, with the command behind
every number: [CHANGELOG.md](../CHANGELOG.md).
