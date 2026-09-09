#!/usr/bin/env node
// cascade — the CLI's front door, and nothing else.
//
// Read the command line, find the command, hand it a context, get out of the
// way. Every command is a module of its own under `src/cli/commands/`, every
// shared helper is a module of its own under `src/cli/`, and this file imports
// nothing but those — so "which command does what" is answered by a table you
// can read in one screen rather than by a chain of `if (cmd === …)` four
// thousand lines long.
//
// The commands, and the page each one is documented on:
//
//   setup         build the SQL lane's python                 docs/setup/sql-lane.md
//   doctor        pre-flight every prerequisite               docs/cli.md
//   init          discover the tree and register the project  docs/cli.md
//   agent         wire an AI client to this project           docs/setup/agents.md
//   analyze       run the lanes end to end -> a pack          docs/cli.md
//   otel-methods  the line the OpenTelemetry agent needs      docs/setup/runtime-evidence.md
//   estimate      what this tree will and does answer         docs/cli.md
//   verify        recompute the deployment receipt            docs/cli.md
//   golden        the project golden corpus                   docs/cli.md
//   catalog       the DB catalog adapter                      docs/setup/db-catalog.md
//   pack          build a pack from SQL-lane output alone     docs/cli.md
//   mcp           serve the tool catalog over stdio           docs/mcp.md
//   impact        query one pack from the shell               docs/cli.md
//   view          serve the viewer over HTTP                  docs/viewer.md

import { wantsHelp } from '../src/cli/args.mjs';
import { makeContext } from '../src/cli/context.mjs';
import { COMMANDS, commandUsage, usageText } from '../src/cli/usage.mjs';
import * as setup from '../src/cli/commands/setup.mjs';
import * as doctor from '../src/cli/commands/doctor.mjs';
import * as init from '../src/cli/commands/init.mjs';
import * as agent from '../src/cli/commands/agent.mjs';
import * as analyze from '../src/cli/commands/analyze/index.mjs';
import * as otelMethods from '../src/cli/commands/otel-methods.mjs';
import * as estimate from '../src/cli/commands/estimate.mjs';
import * as verify from '../src/cli/commands/verify.mjs';
import * as golden from '../src/cli/commands/golden.mjs';
import * as catalog from '../src/cli/commands/catalog.mjs';
import * as pack from '../src/cli/commands/pack.mjs';
import * as mcp from '../src/cli/commands/mcp.mjs';
import * as impact from '../src/cli/commands/impact.mjs';
import * as view from '../src/cli/commands/view.mjs';

/** Command name -> the module that runs it. Keyed by the usage text's order. */
const DISPATCH = Object.freeze({
  setup, doctor, init, agent, analyze, 'otel-methods': otelMethods, estimate,
  verify, golden, catalog, pack, mcp, impact, view,
});

const argv = process.argv.slice(2);
const cmd = argv[0];
const known = Object.prototype.hasOwnProperty.call(DISPATCH, cmd);

// `cascade <command> --help`, ANSWERED BEFORE ANYTHING ELSE IS READ.
//
// This is first on purpose. Every command below reads flags, and three of them
// act on the current directory the moment they start: `analyze` analyzed the
// tree you were standing in, `init` registered it, and `catalog fetch` went
// looking for a database. So `--help` used to be the one flag that did the
// thing instead of explaining it, which is the opposite of what anybody types
// it for.
//
// The rule is therefore blunt and comes before the option readers: if the first
// word is a command this tool has and `--help` or `-h` is anywhere in the rest
// of the line, print that command's section of the usage text and stop. Nothing
// is resolved, nothing is discovered and nothing is written, whatever else the
// line says. `cascade --help`, `cascade help` and a bare `cascade` are not
// commands, so they fall through to the whole text below.
if (known && wantsHelp(argv)) {
  process.stdout.write(commandUsage(cmd));
  process.exit(0);
}

// The dispatch table and the usage text list the same commands, or a reader is
// told about a command that is not there (or not told about one that is). The
// check costs nothing and it is the only thing holding the two lists together.
const undocumented = Object.keys(DISPATCH).filter((name) => !COMMANDS.includes(name));
const unimplemented = COMMANDS.filter((name) => !Object.prototype.hasOwnProperty.call(DISPATCH, name));
if (undocumented.length > 0 || unimplemented.length > 0) {
  process.stderr.write(`cascade: the dispatch table and the usage text disagree (${[...undocumented, ...unimplemented].join(', ')})\n`);
  process.exit(2);
}

if (!known) {
  process.stderr.write(usageText() + '\n');
  process.exit(2);
}

DISPATCH[cmd].run(makeContext(argv));
