# Installation, updates and recovery

[한국어](../ko/setup/installation.md)

Cascade runs on macOS, Linux and Windows with Node 20 or newer. SQL analysis
needs Python and the exact sqlglot pin shipped in `adapters/sql/requirements.txt`
(currently `30.17.0`); Python 3.12 is the CI reference. Java analysis needs a
JDK 17 or newer, with both `java` and `javac`. The web parser is bundled.

## Install and check

```sh
npm install -g @alexsoft-hq/cascade
cascade --version
cascade setup
cascade doctor
```

`setup` may download Python packages. The engine has no npm runtime dependencies.
`doctor --json` provides a machine-readable report and exits 0 only when every
required prerequisite passes; optional DB drivers and Docker do not determine
success. A JDK is installed separately; see the [Java lane](java-lane.md).

For a checkout, use `node bin/cascade.mjs` in place of `cascade`. A package
installed globally uses `<cascade home>/venv`; a checkout defaults to
`<engine>/.venv`. `setup --home` chooses the home environment in a checkout.
`CASCADE_HOME` overrides the tool home (normally `~/.cascade`). Windows venvs
use `Scripts\python.exe`; macOS and Linux use `bin/python`.

Subcommand help such as `cascade analyze --help` exits 0 without doing work.
Whole-program help (`cascade --help`, `-h`, `help`, or no arguments) writes to
stderr and intentionally exits 2. `cascade --version` exits 0 without creating
project files, registry or cache.

## Update and recover

```sh
npm install -g @alexsoft-hq/cascade@latest
cascade --version
cascade setup
cascade doctor
```

Restart an MCP client after updating so its server process loads the installed
version. For a controlled upgrade or rollback, replace `latest` with the exact
published version you intend to use. Re-run `setup` and `doctor` after either.
An update can change analysis workers and parser pins; refresh or re-analyze
projects when the tool reports stale analysis rather than treating an old pack
as current.

A managed Python environment with missing, broken or mismatched sqlglot is
repaired by `cascade setup`. `cascade setup --force` also reinstalls an already
matching environment. Setup retains the previous environment until the
replacement passes verification, restores it if replacement fails, and leaves
registry, cache and project data outside the venv in place. On a failed update,
check the reported error and retry after resolving Python, pip, network or
permissions problems; do not delete the whole tool home to repair its venv.

An explicit `CASCADE_PYTHON` is always read-only to Cascade. `setup` validates
it even with `--force`: the exact parser pin succeeds, while missing or
mismatched sqlglot fails with guidance. Install the reported pin yourself:

```sh
# Replace this executable with the one named by CASCADE_PYTHON.
python -m pip install sqlglot==30.17.0
```

Alternatively unset `CASCADE_PYTHON` (`unset CASCADE_PYTHON` in a POSIX shell,
`Remove-Item Env:CASCADE_PYTHON` in PowerShell), then run `cascade setup`.
A higher-priority checkout `.venv` can still win over the home environment;
`doctor` reports which interpreter is selected.

## CI coverage

The installation workflows define the following checks. These rows describe
configured gates, not a claim that this change has already passed on every
runner; inspect the workflow run for measured results. Execution support above
is broader than these specific combinations.

| Trigger | OS and architecture | Node / Python / JDK | Check |
|---|---|---|---|
| Pull request and main push | macOS 15, Apple Silicon | 22 / 3.12 / Temurin 21 | Full Node suite and required CLI end-to-end fixtures |
| Pull request and main push | Linux x64 | 20 / 3.12 / Temurin 17 | Installed npm tarball smoke |
| Pull request and main push | Linux x64 | 22 / 3.12 / Temurin 21 | Installed npm tarball smoke |
| Pull request and main push | Windows x64 | 22 / 3.12 / Temurin 21 | Installed npm tarball smoke |
| Pull request and main push | macOS 15, Apple Silicon | 22 / 3.12 / Temurin 21 | Installed npm tarball smoke |
| Weekly and manual | macOS 15, Intel | 22 / 3.12 / Temurin 21 | Installed npm tarball smoke |

The installed smoke jobs consume the same packed artifact in isolated consumer
and tool-home directories. This checks what ships through npm, separately from
running source tests in a checkout. Existing Linux, Windows, database and pinned
project checks remain separate coverage.

## Verify a package before release

From a checkout, build and install a scratch tarball without publishing:

```sh
npm run test:package
npm run test:package -- --tarball /path/to/cascade.tgz
```

To verify release identity and installation, select an intended version:

```sh
npm run verify:release -- --tag vX.Y.Z
npm run verify:release -- --npm-version X.Y.Z
npm run verify:release -- --tag vX.Y.Z --npm-version X.Y.Z
npm run verify:release -- --tarball /path/to/cascade.tgz --expected-version X.Y.Z
```

These commands verify artifacts; they do not publish, tag a release, or change
the package version. npm-version verification reads the published artifact and
needs registry access. See the command output for the exact artifact and checks.
