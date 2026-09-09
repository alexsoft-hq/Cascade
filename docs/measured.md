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
| [spring-projects/spring-petclinic](https://github.com/spring-projects/spring-petclinic) | `818c4136` | 9 / 17 | 4 / 7 | 18 / 24 | 12 / 13 | 3 / 8 | 83 |
| [spring-petclinic-microservices](https://github.com/spring-petclinic/spring-petclinic-microservices) | `3858f9c6` | 13 / 15 | 5 / 7 | 20 / 24 | 14 / 14 | 8 / 9 | 54 |

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
| reach | 9 of 17 endpoints reach a statement, 4 tables, 18 columns |
| pages | 12 Thymeleaf templates, 8 of them a controller names |

It has no mapper XML at all: every statement in it is one the JPA bridge derived
from an entity mapping, a derived query name or a `@Query`.

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
