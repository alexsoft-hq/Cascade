# Security policy

## Supported versions

The project is **pre-1.0**, so nothing is published to a package registry yet
(`package.json` is `"private": true`).

| Version | Supported |
|---|---|
| `main` | yes — fixes land here |
| any tag before 1.0 | no — update to `main` |

There is no backport branch. Until 1.0 the answer to "which version is patched"
is "the current `main`".

## Reporting a vulnerability

**Report privately, through GitHub Security Advisories.** On the repository page:
*Security* → *Report a vulnerability*. That opens a private advisory only you and
the maintainers can read, and it is the only reporting route this project has —
there is no maintainer e-mail alias yet, and inventing one here would send your
report nowhere.

- **Do not open a public issue for a vulnerability**, and do not describe one in
  a pull request, a discussion, or a commit message.
- Tell us what you can run: the command, the input tree (or the smallest shape
  of it you can share), what happened, and what you expected. A reproduction we
  can run beats a description of one.
- You will get an acknowledgement in the advisory thread. This is a small
  project with no on-call rotation, so please do not read silence as dismissal —
  ping the thread.
- Please give us time to fix it before publishing. We will credit you in the
  advisory unless you ask us not to.

GitHub's own instructions for the reporting form:
<https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability>

## What this tool touches — the scope you are reporting against

This is a static analyzer for somebody else's source tree. Four facts shape
what a vulnerability in it looks like.

**1. It reads your source, and treats it as untrusted input.** The analyzed
repository is not trusted, and two of the three defences that follow from that
are implemented. The catalog adapter prints the exact target and
**refuses to connect without `--yes`**, because the connection details came out
of the repository being analyzed and could point at an attacker's database
(`test/catalog_fetch.test.mjs`). The analyzers **run no project build** — the
Java lane is the JDK's own parser with no Gradle/Maven invocation and no
dependency classpath, and the SQL lane is a parser too — so a hostile
`build.gradle` or `pom.xml` in an analyzed tree executes nothing.
The third defence is **not** implemented: an MCP response does not yet mark
evidence text (SQL, comments, string literals) as untrusted data, so a comment
in an analyzed repository that is written as an instruction reaches a consuming
model unmarked. That is invariant I-2 and it is an open gap, recorded in
[CONTRIBUTING.md](CONTRIBUTING.md#the-invariants-and-the-tests-that-hold-them).

**2. The pack carries your business vocabulary.** `pack.json` holds the
**column comments** copied out of your DDL or catalog snapshot — in many
projects that is the clearest description of the business rules anywhere. It
does **not** hold SQL statement text: a statement node carries its file and
line, and the viewer's local `/api/source` route reads the statement out of your
working tree on demand. `cascade init` therefore writes a `.cascade/.gitignore`
that ignores `pack/` and `catalog/` — privacy as code, not as a warning in a
document (`src/core/paths.mjs`).

**3. Credentials are never stored.** A database password is read only from the
environment variable you name with `--password-env`, never from the command line
(argv is world-readable in `ps`), and it is written to no file — not
`.cascade/`, not the pack, not the receipt, not the registry, not a log. A
driver exception that quotes the connection string back is scrubbed before it is
printed (`src/core/dbconfig.mjs`).

**4. The servers are local.** `cascade view` binds `127.0.0.1` and `cascade mcp`
speaks stdio. Neither authenticates, because neither is meant to be reachable
from anywhere else. If you put a reverse proxy in front of the viewer, you have
published every column comment and every source file it can read — that is a
deployment decision, not a defect in the tool.

## What IS a vulnerability here

- Executing code from an analyzed repository (a build hook, a plugin, a
  deserialization path) during `init`, `analyze`, `estimate` or a query.
- A password, token or full connection string appearing in any written artifact,
  a log line, an error message, or the pack.
- Path traversal: an analyzed tree causing a read or a write outside the
  directories the command was pointed at, including through a symlink or a
  crafted path inside a mapper XML.
- The viewer or the MCP server serving a file outside the analyzed repository,
  or answering for a project the caller did not ask for.
- A denial of service that a *modest* input triggers — an input that hangs or
  exhausts memory out of proportion to its size.
- Anything that lets one project's answer leak into another project's response
  on a multi-project server.

## What is NOT a vulnerability

These are real bug reports and we want them — as **normal public issues**, not
as advisories.

- **An accuracy bug.** "The engine reports a column as reachable that is not",
  or misses one that is. Over-approximation is the design (`SOUND_SET`); a wrong
  answer is a correctness bug and belongs in the open, with the fixture that
  shows it.
- **A grade you disagree with.** Argue it in an issue against
  `src/core/policy.mjs` and its table.
- **A missing framework or language.** The tool is not language-agnostic and
  does not claim to be. "It does not understand my framework" is a feature
  request.
- **Analyzing a hostile repository is slow.** Unless it is out of proportion to
  the input size, that is the cost of reading a large tree, not a defect.
- **The local viewer has no authentication.** By design; see point 4 above.
- **A dependency CVE in the SQL lane's `sqlglot`.** Report it upstream and open
  a normal issue here to bump the pin. The engine itself has zero runtime
  dependencies.
