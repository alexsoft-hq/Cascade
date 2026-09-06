# Contributing

This engine exists to say *what it can prove and what it cannot*. Every rule
below follows from that, and most of them are enforced by a test rather than by
a reviewer's memory — where they are not, this page says so out loud.

Apache-2.0 (`LICENSE`).

## How a change gets in: the round

Work here happens in rounds, and a round has three parts. A **brief** says what
this round builds and what it is not allowed to touch, in prose, before anybody
opens an editor. An **implementer** writes the code and the tests, runs both
suites, and reports what was measured rather than what was intended. Then the
round is **verified by somebody who did not write it**: every number in the
report is recomputed independently, by a second path rather than by re-running
the implementer's own command, and anything that draws a picture is opened in a
real browser and looked at. A number nobody recomputed and a screen nobody
opened are the two ways a green suite still ships a defect, so the round is not
finished until both have happened. A contribution from outside follows the same
shape: say what you are changing before you change it, and report the numbers
you actually saw.

## Run the suites first

Three of them, and they are independent on purpose: a lane you do not have
installed must not be able to hide the state of the ones you do.

```bash
# 1. Node — the engine, the MCP surface, the viewer's pure logic
npm run test:quick                 # node --test test/*.test.mjs
npm test                           # the same, with --experimental-test-coverage

# 2. Python — the SQL lane's workers
python3 -m venv .venv
.venv/bin/pip install -r adapters/sql/requirements.txt
.venv/bin/python -m unittest discover -s adapters/sql -p 'test_*.py'

# 3. Java — the source lane's worker, compiled and run over a fixture
javac -d .java-build adapters/java/JavaFacts.java
node scripts/ci-java-smoke.mjs
```

Before any of that, ask the tool what it is missing:

```bash
node bin/cascade.mjs doctor        # every prerequisite, its state, and the remedy
```

`doctor` exits 0 only when every **required** prerequisite is ok. The optional
ones (the three DB drivers, Docker) are reported and never fatal — the analysis
path never connects to a database, so a missing driver costs you
`cascade catalog fetch` and nothing else.

Some tests need a fixture and **skip out loud** without one, naming both the
fixture and the command that produces it: `spring-petclinic` (the JPA lane),
`jpetstore-6` (the SQL lane), and a built pack of `macrozheng/mall` at a pinned
digest (the large-project goldens). CI clones all three at pinned commits and
**fails if any of those tests skips** — a permanent self-omission on a fresh
clone is a defect, not a pass.

## What a pull request has to carry

Each row names the gate by what it actually checks, so you can tell at a glance
whether a machine will catch you or a person has to.

| The gate | What it checks | How it is checked |
|---|---|---|
| tests ship with the code | the implementation and its tests are in the **same** PR | review — no automated gate |
| coverage does not drop | the coverage table after your change against the one before | `npm test` prints the table; **no threshold is enforced in CI today** — a reviewer reads it |
| runtime strings are English | every string a user or a model can see is English, `viewer/i18n/*.json` excepted | `test/gates.test.mjs` (always on) |
| no internal coordinates | no private IP, no host outside a small allowlist, no personal e-mail address, no home-directory path anywhere in the tree | `test/gates.test.mjs` (always on) |
| no NUL byte | no source file contains a literal NUL; write control characters as escapes | `test/gates.test.mjs` (always on) |
| every commit signed off | each commit carries a `Signed-off-by` trailer that is the author's own | `scripts/check-dco.mjs`, the `dco` CI job |
| no npm dependencies | `package.json` declares no `dependencies`; the two vendored bundles are credited in `NOTICE` and their bytes are pinned to a published sha256 | `test/gates.test.mjs` (always on) |
| the documentation matches the binary | every command and flag the CLI prints is on `docs/cli.md`, every tool in the catalog is on `docs/mcp.md`, and no page names a private document | `test/docs.test.mjs` |

### Sign your commits off (DCO)

This project uses the [Developer Certificate of Origin 1.1](DCO) — the same
mechanism the Linux kernel uses — instead of a CLA. Certify that you wrote the
patch, or otherwise have the right to submit it, by adding a `Signed-off-by:`
trailer with **your own** name and e-mail:

```bash
git commit -s                      # adds the trailer from your git identity
git commit --amend -s --no-edit    # fix the last commit
git rebase --signoff <base>        # fix a whole branch
```

The check runs on every pull request (the `dco` job in
`.github/workflows/ci.yml`, checked out with `fetch-depth: 0` so the base ref
exists) and you can run it yourself:

```bash
node scripts/check-dco.mjs                      # origin/main..HEAD
node scripts/check-dco.mjs --range <base>..HEAD
node scripts/check-dco.mjs --commits <sha> …
```

It fails, naming the offending SHAs, when a commit has no trailer **or** when
the trailer's e-mail is not the commit author's. That second half matters: a
sign-off by somebody else certifies nothing about your commit.

## The invariants, and the tests that hold them

Nine rules hold this engine together and no refactor may break one. Each is
supposed to have a test, and a tamper test, behind it. Here is the honest state
of that:

| Invariant | What it says | Test |
|---|---|---|
| **I-1** no promotion | a candidate set of one is never promoted to `EXACT`; the lattice is computed in one place | `test/policy.test.mjs`, `test/graph.test.mjs`, `test/overlay_graph.test.mjs`, `test/jpa_bridge.test.mjs`, `test/changed_impact.test.mjs` |
| **I-2** extracted source is untrusted data | evidence text (SQL, comments, literals) must be MARKED as untrusted data in an MCP response so a consuming model cannot read it as instruction | **no test — and no implementation.** The response contract carries no untrusted-data marker today. The other two defences against a hostile analyzed repository *are* implemented: `catalog fetch` refuses to connect without `--yes` (`test/catalog_fetch.test.mjs`, `test/init.test.mjs`), and the analyzers run no project build |
| **I-3** import direction | `viewer/mcp → adapters → core`; core imports nothing | `test/gates.test.mjs` — an always-on gate reads every import in `src/core/` (including `export … from` and dynamic `import()`) and fails on one that resolves into `adapters/`, with a second test showing the same check firing on a planted import. The one live exception is gone: the assembly `src/core/overlay.mjs` needed is now `src/core/assemble.mjs`, which takes the bridges as INJECTED functions (`test/assemble.test.mjs`); `bin/cascade.mjs` wires them for both `analyze` and the overlay |
| **I-4** unknown schema stays unknown | `schema.default: null` means no invented schema name | `test/init.test.mjs`, `test/lanes.test.mjs`, `test/profile.test.mjs` |
| **I-5** no dead profile keys | every declared key is consumed or diagnosed | `test/profile_keys.test.mjs`, `test/lanes.test.mjs` |
| **I-6** one publish gate | every consumer passes a single gate checking binding, generation and lock digests | **partially realized.** There is no `loadFacts()`. What exists: `loadPack({verifyDigest:true})` refuses a pack whose bytes do not match its digest (`test/pack.test.mjs`) and `planIncremental` refuses a mixed-generation shard set, naming which worker moved (`test/invalidate.test.mjs`). The classpath-binding half does not apply — this engine has no bytecode lane |
| **I-7** evidence → grade is a total function | every evidence shape maps to a grade; two lanes disagreeing forbids `EXACT` | `test/policy.test.mjs` |
| **I-8** the contract cannot be forged | contract fields are stamped with a private Symbol; a look-alike dies in `assertContract()` | `test/contract.test.mjs`, `test/overlay_integration.test.mjs` |
| **I-9** incremental == cold | an incremental pack equals a cold pack of the same state, byte for byte | `test/incremental.test.mjs` (metamorphic: random mutations, seeded) |

If you change code an invariant covers, extend its test in the same PR. If you
find one of the gaps above closable, close it in a PR of its own so the change
is reviewable as what it is.

## Contributions we do not accept

This is not a style preference. Honesty is the only durable difference this
tool has, and each of the claims below contradicts a mechanism the code
implements — fail-closed ingest, a grade lattice that never promotes, measured
lower bounds.

- **Claims of completeness.** "complete impact", "full blast radius", "finds
  every caller". `HEURISTIC` and `SOUND_SET` exist precisely because the answer
  is not complete.
- **Claims of safety.** "safe refactoring guaranteed". The tool *narrows* the
  set you have to read. It guarantees nothing about your refactor.
- **"Language-agnostic" / "100% accurate".** A tool whose quality gate publishes
  a measured lower bound cannot say either.
- **"A SAST/CodeQL replacement."** Security detection is not the goal.
- **An invented trust level.** With no golden corpus the level is `UNCERTIFIED`,
  and it is computed rather than typed in. A PR that hard-codes a nicer one
  will be rejected.
- **Code that promotes a grade.** Narrowing a candidate set to one member does
  not make it `EXACT` (I-1). If you think an evidence shape deserves a higher
  grade, change the central policy table and its property test — never a call
  site.
- **Silent fallbacks.** "no previous index" must not read as "nothing changed";
  a damaged shard must not be loaded; an empty result must say *why* it is
  empty (`not-shipped` / `none`), never just `[]`. A `catch {}` that swallows a
  reason is the bug this project is most allergic to.
- **Hard-coded product literals.** No company, product or schema name belongs in
  `src/` or `adapters/`. A rule that needs one is a rule that does not
  generalise. Synthetic fixtures use `com.example.*` and
  RFC 2606 names (`example.com`, `db.example.com`, `*.invalid`).
  *Enforcement, honestly:* `test/gates.test.mjs` catches internal coordinates
  (private IPv4, hosts outside a small allowlist, personal e-mail addresses,
  home-directory paths) on every run. A vendor-name grep runs only when a
  contributor drops literals into a gitignored `.cascade-denylist`; there is no
  always-on vendor list, because shipping one would mean shipping the names.

## Reviewer checklist

Read the diff against these five, in this order:

1. **Contract fields.** Does every new response go through `src/mcp/contract.mjs`
   and carry `basis` / `trust` / `limits` / `truncated`? A response assembled by
   hand is a response with no honesty fields, and `assertContract()` must be the
   thing that says so (I-8).
2. **Empty reasons.** Every empty list says why it is empty. `not-shipped`,
   `degraded` and `none` are three different answers and must not collapse into
   an empty array.
3. **English strings.** Every string a user or a model can see is English. The
   only exception is `viewer/i18n/*.json`, which *is* the translation, and is
   the one path excluded from the gates.
4. **No NUL bytes.** `od -An -tx1 <file> | grep ' 00'` must print nothing.
   Write control characters as escapes (`\\u0000`), never as bytes.
5. **Grades and diagnostics.** New evidence produces a grade through
   `src/core/policy.mjs`, and anything unresolved becomes a named diagnostic
   rather than a dropped row.

## Style

- **No npm dependencies** in the engine or the servers. Two things are vendored
  and credited in `NOTICE`: the viewer's MIT browser bundles under
  `viewer/vendor/`, and the web lane's MIT parser (`@babel/parser`) under
  `adapters/web/vendor/`. A gate checks that every one of them is named in
  `NOTICE`, and a second gate pins the parser to the sha256 its own README
  publishes.
- Pure logic goes in a `src/` module with tests; scripts under `scripts/` and
  the CLI in `bin/` stay thin shells over it. That is what lets a test cover the
  states your machine does not happen to be in.
- Comments say *why*, especially why an obvious simpler thing is wrong. The
  existing files are the style guide.
- Documentation is checked too: `test/docs.test.mjs` fails when `bin/cascade.mjs`
  grows a command or a flag that `docs/cli.md` does not mention, or when
  `toolList()` grows a tool that `docs/mcp.md` does not.

## Security issues

Do **not** open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).

## Code of conduct

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
(Contributor Covenant 2.1).
