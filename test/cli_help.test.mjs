// cli_help.test.mjs — `--help` explains a command instead of running it.
//
// THE DEFECT THIS HOLDS SHUT. `cascade analyze --help` used to analyze the
// directory you were standing in and write a pack into it; `cascade init --help`
// registered that directory in the home registry. Nothing in the code said
// "--help", so the flag fell through to the command body and the command did its
// job. That is the one flag a person types when they do NOT want the job done.
//
// So the rule is checked here for EVERY command in the dispatch table, and it is
// checked twice over: the exit code and the text say the help was printed, and
// the directory and the registry say nothing happened. A run in a scratch
// directory with a scratch CASCADE_HOME is the only honest way to check the
// second half — the bug was discovered by a run that did not have one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { COMMANDS, commandUsage, usageText } from '../src/cli/usage.mjs';

const ENGINE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const CLI = path.join(ENGINE_ROOT, 'bin', 'cascade.mjs');

/**
 * Run the CLI in a directory of its own, with a tool home of its own. Both are
 * fresh for every invocation, so one command's leftovers cannot make the next
 * command's answer look clean.
 */
function runIsolated(t, argv) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-help-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const cwd = path.join(base, 'cwd');
  const home = path.join(base, 'home');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const registry = path.join(home, 'registry.json');
  const r = spawnSync(process.execPath, [CLI, ...argv], {
    cwd,
    env: { ...process.env, CASCADE_HOME: home, XDG_CACHE_HOME: path.join(home, 'cache') },
    encoding: 'utf8',
    timeout: 60000,
  });
  return {
    exit: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    cwdEntries: fs.readdirSync(cwd).sort(),
    registryExists: fs.existsSync(registry),
  };
}

test('every command answers --help with its own section, exit 0, and touches nothing', (t) => {
  for (const cmd of COMMANDS) {
    const r = runIsolated(t, [cmd, '--help']);
    assert.equal(r.exit, 0, `cascade ${cmd} --help exited ${r.exit}: ${r.stderr.slice(0, 300)}`);
    assert.equal(r.stderr, '', `cascade ${cmd} --help wrote to stderr: ${r.stderr.slice(0, 300)}`);
    assert.equal(
      r.stdout.split('\n')[0].startsWith(`cascade ${cmd}`), true,
      `cascade ${cmd} --help must open with its own name, got: ${JSON.stringify(r.stdout.slice(0, 120))}`,
    );
    assert.equal(r.stdout, commandUsage(cmd), `cascade ${cmd} --help must print exactly that command's section`);
    // Nothing happened: no `.cascade/` in the directory it ran in, and no
    // registry in the home it was pointed at.
    assert.deepEqual(r.cwdEntries, [], `cascade ${cmd} --help left something in the working directory`);
    assert.equal(r.registryExists, false, `cascade ${cmd} --help wrote a registry`);
  }
});

test('-h is the same rule as --help', (t) => {
  for (const cmd of COMMANDS) {
    const r = runIsolated(t, [cmd, '-h']);
    assert.equal(r.exit, 0, `cascade ${cmd} -h exited ${r.exit}: ${r.stderr.slice(0, 200)}`);
    assert.equal(r.stdout, commandUsage(cmd));
    assert.deepEqual(r.cwdEntries, []);
  }
});

test('--help wins over every other flag on the line, wherever it sits', (t) => {
  // The three that used to act on the current directory, each given the flags
  // that would have made them act.
  const lines = [
    ['analyze', '--root', '.', '--help'],
    ['analyze', '--help', '--cold'],
    ['init', '--project', 'demo', '--help'],
    ['catalog', 'fetch', '--yes', '--help'],
    ['view', '--port', '4319', '--help'],
    ['mcp', '--memory-budget', '8', '--help'],
  ];
  for (const argv of lines) {
    const r = runIsolated(t, argv);
    assert.equal(r.exit, 0, `${argv.join(' ')} exited ${r.exit}: ${r.stderr.slice(0, 300)}`);
    assert.equal(r.stdout, commandUsage(argv[0]), `${argv.join(' ')} printed something else`);
    assert.deepEqual(r.cwdEntries, [], `${argv.join(' ')} left something behind`);
    assert.equal(r.registryExists, false, `${argv.join(' ')} wrote a registry`);
  }
});

test('the whole text still answers a bare command, `--help` and `help`, on stderr', (t) => {
  for (const argv of [[], ['--help'], ['-h'], ['help']]) {
    const r = runIsolated(t, argv);
    assert.equal(r.exit, 2, `cascade ${argv.join(' ')} should still exit 2`);
    assert.equal(r.stdout, '', 'the whole usage text goes to stderr, as it always has');
    assert.equal(r.stderr, `${usageText()}\n`);
  }
});

test('a command section is a slice of the whole text, and every command has one', () => {
  const whole = usageText();
  for (const cmd of COMMANDS) {
    const section = commandUsage(cmd);
    assert.ok(section, `no usage section for ${cmd}`);
    // The section is the same lines, indented by two inside the whole text.
    const indented = section.split('\n').map((l) => (l ? `  ${l}` : l)).join('\n');
    assert.ok(whole.includes(indented), `${cmd}'s section is not the text the whole usage carries`);
  }
  assert.equal(commandUsage('nonesuch'), null, 'a name the table does not carry has no section');
});
