// usage.mjs — what `cascade` says when it is asked what it can do.
//
// ONE TEXT, TWO READERS. A reader who types `cascade` with no arguments wants
// the whole map; a reader who types `cascade analyze --help` wants one command
// and nothing else. Both come out of the SAME table below, one entry per
// command in the order the dispatch table tries them, so a flag added to a
// command cannot appear in one and not in the other.
//
// The whole text is also the authority `test/docs.test.mjs` checks `docs/cli.md`
// against: every command it lists must have a section on the page, and every
// long flag it mentions must appear there. That is why the flags are spelled
// out here rather than summarised — the page is checked against this, and this
// is checked against nothing, so it is the thing that has to be right.

/** The commands the dispatch table answers to, in the order the usage lists them. */
export const COMMANDS = Object.freeze([
  'setup', 'doctor', 'init', 'agent', 'analyze', 'otel-methods', 'estimate',
  'verify', 'golden', 'catalog', 'pack', 'mcp', 'impact', 'view',
]);

/** The first line: what a reader sees before any detail. */
export const USAGE_HEADER = 'usage: cascade <setup|doctor|init|agent|analyze|otel-methods|estimate|verify|golden|catalog|pack|mcp|impact|view> …\n';

/**
 * The last word, after every command: where a pack is looked for. It belongs to
 * no single command, because it is the rule ALL of them resolve a project by.
 */
export const USAGE_FOOTER = '\nA pack is located by: --pack > --project (~/.cascade/registry.json) > --root/.cascade > ./.cascade';

/** One entry per command: exactly the lines that command owns in the whole text. */
export const USAGE = Object.freeze({
  setup:
    '  cascade setup [--force] [--home]\n'
    + '      (build the SQL lane\'s python and install its pinned requirements. --force rebuilds an\n'
    + '       existing one; --home puts it in the tool home even inside a checkout. Nothing else needs it)\n',
  doctor:
    '  cascade doctor [--json]\n'
    + '      (pre-flight every prerequisite at once: node, git, the SQL lane\'s venv and sqlglot,\n'
    + '       a JDK (naming which candidate won and why the others did not), the optional DB\n'
    + '       drivers, docker, the registry and the cache directory. Exit 0 only when every\n'
    + '       REQUIRED prerequisite is ok; the optional ones are reported, never fatal.)\n',
  init:
    '  cascade init [--root <dir>] [--project <id>] [--force] [--json]\n',
  agent:
    '  cascade agent [--client claude-code|cursor|codex|all] [--write] [--project <id>] [--root <dir>]\n'
    + '      (put the MCP server config AND the rule that says when to ask into the project:\n'
    + '       .mcp.json + CLAUDE.md for Claude Code, .cursor/mcp.json + .cursor/rules/cascade.mdc\n'
    + '       for Cursor, AGENTS.md plus a TOML block to paste for Codex. Without --write it prints\n'
    + '       every file it would write instead of writing one. Claude Code holds a project\n'
    + '       .mcp.json at "Pending approval" until you run `claude` there once and approve it.)\n',
  analyze:
    '  cascade analyze [--root <repo>] [--out <dir>] [--profile <f>] [--cold | --incremental] [--accept-baseline]\n'
    + '                  [--ddl <schema.sql|glob>... | --no-ddl] [--mappers <dir>... | --no-mappers] [--java-src <dir>... | --no-java]\n'
    + '                  [--web-src <dir>... | --no-web] [--openapi <file>... | --no-openapi]\n'
    + '                  [--har <file>...] [--otel <file>...]\n'
    + '      (with no lane flag the inputs come from the project manifest + profile + discovery;\n'
    + '       --no-<lane> switches a lane off even then. An unflagged run reads MAIN java sources\n'
    + '       only. The src/test roots it skipped are printed, and --java-src includes one.)\n'
    + '      (--web-src reads a frontend source root: the web lane traces each HTTP call to the client\n'
    + '       that sends it and attaches it to the route this pack serves, as a graded CALLS_HTTP edge.\n'
    + '       The `web` axis says what had to be guessed. See docs/setup/web-lane.md)\n'
    + '      (--openapi reads an OpenAPI 3 / Swagger 2 document, JSON or YAML: every route it declares\n'
    + '       becomes an endpoint, one the code also serves is corroborated, and the routes the two\n'
    + '       disagree about are reported as drift. Repeatable. See docs/setup/web-lane.md)\n'
    + '      (--har reads a browser recording (HAR 1.2, what DevTools saves): every request in it that\n'
    + '       matches a route this pack serves becomes a screen-to-route edge graded RUNTIME_ONLY, which\n'
    + '       is SHOWN as `observed` and never walked. Repeatable; the profile can name them instead in\n'
    + '       runtimeEvidence.har. Nothing is discovered: a recording is made on purpose.)\n'
    + '      (--otel reads an OpenTelemetry trace export (OTLP/JSON): which implementation really handled\n'
    + '       a request and which statement really ran. A confirmed hop keeps its grade and gains\n'
    + '       `observed`, an unobserved candidate is left exactly as it was, and a hop no static rule\n'
    + '       explains becomes a RUNTIME_ONLY edge that is shown and never walked. Repeatable; the\n'
    + '       profile can name them instead in runtimeEvidence.otel. See docs/setup/runtime-evidence.md)\n'
    + '      (every run is judged against the previous certified run sealed in .cascade/calibration/:\n'
    + '       a regression writes the pack to <packDir>-rejected/ and exits 3, leaving the certified\n'
    + '       pack untouched. --accept-baseline re-seals the baseline FROM THIS RUN: the one override,\n'
    + '       and a human decision.)\n',
  'otel-methods':
    '  cascade otel-methods [--pack <dir> | --project <id> | --root <dir>] [--json]\n'
    + '      (print the `otel.instrumentation.methods.include` value this pack needs: every route\n'
    + '       handler and every method that reaches a statement, grouped by class as pkg.Class[m1,m2]\n'
    + '       and joined with semicolons. The Java agent takes explicit method names, never a\n'
    + '       wildcard, and without them the dispatch join sees nothing because no controller or\n'
    + '       service method has a span. The value goes to stdout alone, so it can be pasted or\n'
    + '       piped. --json prints the same as {class: [methods]}. See docs/setup/runtime-evidence.md)\n',
  estimate:
    '  cascade estimate [--root <dir>] [--project <id>] [--json]\n',
  verify:
    '  cascade verify [--pack <dir> | --project <id> | --root <dir>] [--json]\n'
    + '      (recompute every digest in .cascade/receipt.json from the files, check the running engine\n'
    + '       against the one that signed it, and refuse an expired receipt. Exit 4 on any disagreement)\n',
  golden:
    '  cascade golden <propose|approve|seal|check> [--pack <dir> | --project <id> | --root <dir>]\n'
    + '                 [--per-relation N] [--from-otel <trace file>] [--ids <id>…] [--all] [--json]\n'
    + '      (the project golden corpus. propose SUGGESTS cases from the current pack; only\n'
    + '       `approve --ids …` / an explicit `--all` makes one evidence. The tool never approves itself.\n'
    + '       --from-otel proposes from an OpenTelemetry trace instead, so the labels come from a RUN\n'
    + '       rather than from this engine. A run proves reach, so those cases score recall only.)\n',
  catalog:
    '  cascade catalog discover [--project <id>|--root <dir>] [--json]\n'
    + '      (list the datasource connection info this tree carries: host, port, database, dialect,\n'
    + '       and WHETHER a password is there. No password value is read, printed or stored, and\n'
    + '       nothing is connected to.)\n'
    + '  cascade catalog fetch [--project <id>|--root <dir>]\n'
    + '                        [--candidate <n> | --url <jdbc url> --user <u>\n'
    + '                         | --dialect <d> --host <h> [--port <p>] --database <db> --user <u>]\n'
    + '                        [--password-env NAME] [--schema NAME] [--stamp-schema NAME] [--yes]\n'
    + '      (pin a READ-ONLY catalog snapshot into .cascade/catalog/, then write catalog.source: "jdbc"\n'
    + '       into the profile so the next analyze reads it. It prints the exact target first and asks\n'
    + '       y/N in a terminal, or refuses without --yes outside one: the connection info comes from\n'
    + '       the analyzed repository, which is untrusted input. The password is read, in order, from\n'
    + '       --password-env, from CASCADE_DB_PASSWORD, from the credentials file, or from a hidden\n'
    + '       prompt. It is never an argument and never written to the project.)\n'
    + '  cascade catalog credentials list\n'
    + '  cascade catalog credentials set    --url <jdbc url> --user <u> [--password-env NAME]\n'
    + '  cascade catalog credentials remove --url <jdbc url> --user <u>\n'
    + '      (the passwords `catalog fetch` may use, in $CASCADE_HOME/credentials at mode 0600: one\n'
    + '       JSON object per line, keyed by server and user, never under a project tree. A file that\n'
    + '       group or others can read is REFUSED with the chmod to run. `list` prints servers and\n'
    + '       users and never a password. --dialect/--host/--port/--database name the same target\n'
    + '       field by field.)\n',
  pack:
    '  cascade pack --catalog <f> --lineage <f> --out <dir>\n',
  mcp:
    '  cascade mcp [--pack <dir> | --project <id> ... | --root <dir>] [--memory-budget <MB>]\n'
    + '      (with no --pack/--root/--project it serves EVERY registered project, lazily: a pack is\n'
    + '       parsed on the first call that needs it, and the loaded ones are held in an LRU under\n'
    + '       the memory budget: 512 MB of pack JSON by default. Each tool takes a `project`\n'
    + '       argument; on a multi-project server a call without one is answered `ambiguous`.)\n',
  impact:
    '  cascade impact [--pack <dir> | --project <id> | --root <dir>] [--file <path>...] [--verbose]\n'
    + '                 [--mode strict|conservative|heuristic|base-only]\n'
    + '      (default: the dirty files are re-parsed and the answer describes the working tree;\n'
    + '       --mode base-only answers from the pack alone: the PRE-EDIT structure, labelled as such)\n',
  view:
    '  cascade view [--pack <dir> | --project <id> ... | --root <dir>] [--port 4319] [--memory-budget <MB>]\n'
    + '      (same project selection as `mcp`; the page shows one project at a time. Open it with\n'
    + '       ?project=<id> when the server serves several)\n',
});

/**
 * The whole usage text, in dispatch order. `cascade` with no command, `cascade
 * --help` and `cascade help` all print this, and `test/docs.test.mjs` reads it
 * out of the running binary to check the page against it.
 */
export function usageText() {
  return USAGE_HEADER + COMMANDS.map((name) => USAGE[name]).join('') + USAGE_FOOTER;
}

/**
 * ONE command's section, as its own help page: the same lines with the two
 * spaces that indent them inside the whole text taken off, so the first line
 * reads `cascade analyze …` rather than sitting under a heading that is not
 * there. Null for a name the table does not carry.
 */
export function commandUsage(name) {
  if (!Object.prototype.hasOwnProperty.call(USAGE, name)) return null;
  return USAGE[name].split('\n').map((line) => (line.startsWith('  ') ? line.slice(2) : line)).join('\n');
}
