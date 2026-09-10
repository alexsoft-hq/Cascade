// cli_unknown_project.test.mjs — an unknown `--project` is a typo, not an
// instruction.
//
// THE DEFECT THIS HOLDS SHUT, and it is the `--help` defect one door along.
// `cascade analyze --project mal` (for `mall`) printed `unknown project "mal"`,
// then `-> continuing with the local .cascade/`, and analyzed whatever directory
// the shell happened to be in, writing a pack that called itself `mal`. One line
// of stderr stood between a reader and believing they had just re-analyzed mall.
// `estimate` and `catalog fetch` did the same, and `catalog discover` accepted
// the flag and ignored it altogether.
//
// So every command that LOOKS a project up now dies with the registered ids, the
// way `mcp` and `view` always have. It is checked twice over, like the help
// rule: the exit code and the text say what happened, and the directory and the
// registry say nothing did.
//
// THE PLACES THE RULE DOES NOT REACH are checked here too, because "every
// command dies on an unknown id" would be the wrong rule and this is where
// somebody would come to tighten it:
//   `init`     REGISTERS the name it is given, so it cannot look it up first
//   `pack`     uses it to LABEL the output and never reads the registry
//   `analyze`  labels its pack with it as well, which test/project_identity.test.mjs
//              seals. With `--root` or `--pack` also given the target is named
//              and the working directory is never taken, so the id is metadata
//              and the run says so. With NEITHER, the id was the only thing
//              choosing a target and an unknown one is fatal, which is the
//              defect above.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ENGINE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const CLI = path.join(ENGINE_ROOT, 'bin', 'cascade.mjs');

/** A registry with two projects in it, so the error has ids to list. */
const REGISTRY = JSON.stringify({
  schema: 'cascade:registry:1',
  projects: [
    { id: 'alpha', dotCascadePath: '/nowhere/alpha/.cascade', source: 'init', stack: ['sql'], lastCertifiedAt: null },
    { id: 'beta', dotCascadePath: '/nowhere/beta/.cascade', source: 'init', stack: ['sql'], lastCertifiedAt: null },
  ],
}, null, 1);

/**
 * Run the CLI in an EMPTY directory of its own, with a tool home of its own.
 * Both are fresh for every invocation: the whole point is that a command which
 * fell through would leave something behind here, and a shared directory would
 * hide it.
 */
function runIsolated(t, argv, { withRegistry = true } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-unknown-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const cwd = path.join(base, 'cwd');
  const home = path.join(base, 'home');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const registry = path.join(home, 'registry.json');
  if (withRegistry) fs.writeFileSync(registry, REGISTRY);
  const r = spawnSync(process.execPath, [CLI, ...argv], {
    cwd,
    env: { ...process.env, CASCADE_HOME: home, XDG_CACHE_HOME: path.join(home, 'cache') },
    encoding: 'utf8',
    timeout: 120000,
  });
  return {
    exit: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    cwdEntries: fs.readdirSync(cwd).sort(),
    registry: fs.existsSync(registry) ? fs.readFileSync(registry, 'utf8') : null,
  };
}

/** Every command whose `--project` is a lookup in the registry. */
const LOOKS_UP = [
  ['analyze', '--project', 'nope'],
  ['estimate', '--project', 'nope'],
  ['catalog', 'discover', '--project', 'nope'],
  ['catalog', 'fetch', '--project', 'nope'],
  ['golden', 'check', '--project', 'nope'],
  ['otel-methods', '--project', 'nope'],
  ['impact', '--column', 'a.b', '--project', 'nope'],
  ['verify', '--project', 'nope'],
  ['mcp', '--project', 'nope'],
  ['view', '--project', 'nope'],
];

test('an unknown --project exits 2, names the registered ids, and does nothing', (t) => {
  for (const argv of LOOKS_UP) {
    const r = runIsolated(t, argv);
    const said = `${r.stdout}${r.stderr}`;
    const what = `cascade ${argv.join(' ')}`;
    assert.equal(r.exit, 2, `${what} exited ${r.exit}: ${said.slice(0, 400)}`);
    assert.match(said, /unknown project "nope"/, `${what} did not name the id it was given`);
    assert.match(said, /alpha, beta/, `${what} did not list the registered ids: ${said.slice(0, 400)}`);
    // The second half, and the one the defect was hiding behind: nothing ran.
    assert.deepEqual(r.cwdEntries, [], `${what} left ${r.cwdEntries.join(', ')} in an empty directory`);
    assert.equal(r.registry, REGISTRY, `${what} rewrote the registry`);
    assert.doesNotMatch(said, /continuing with the local/, `${what} carried on anyway`);
  }
});

test('with an EMPTY registry the same commands say how to fill it, and still do nothing', (t) => {
  // The other half of the message: there are no ids to list, so the sentence has
  // to say what to run instead. A reader who has never run `init` meets this one.
  const r = runIsolated(t, ['analyze', '--project', 'nope'], { withRegistry: false });
  assert.equal(r.exit, 2, r.stderr.slice(0, 400));
  assert.match(r.stderr, /unknown project "nope": the registry at .* is empty/);
  assert.match(r.stderr, /cascade init/);
  assert.deepEqual(r.cwdEntries, []);
});

test('`analyze --root` with an unknown id keeps it as a NAME, and says which flag chose the tree', (t) => {
  // The tree is named, so nothing is retargeted: what is left of `--project` is
  // the pack's own name, and the run states that rather than going quiet.
  const r = runIsolated(t, ['analyze', '--project', 'nope', '--root', '.']);
  const said = `${r.stdout}${r.stderr}`;
  assert.match(said, /unknown project "nope"/, said.slice(0, 400));
  assert.match(said, /--root names the target, so the id is used for the pack's own name/, said.slice(0, 600));
  // It really did go on to analyze the named tree (and then fail on an empty
  // directory with no commit, which is the honest next error).
  assert.match(said, /analyzing .*\(--root\)/, said.slice(0, 600));
});

test('`init` REGISTERS the name it is given, so an unknown id is not an error there', (t) => {
  // The command that gives a project its id cannot be asked to look it up first.
  // It fails here for the reason it should (no commit to pin), not for the name.
  const r = runIsolated(t, ['init', '--project', 'nope']);
  const said = `${r.stdout}${r.stderr}`;
  assert.doesNotMatch(said, /unknown project/, said.slice(0, 400));
  assert.match(said, /no git repository/);
});

test('`pack` only LABELS its output with --project, and never looks one up', (t) => {
  const r = runIsolated(t, ['pack', '--catalog', '/dev/null', '--lineage', '/dev/null', '--out', 'out', '--project', 'nope']);
  const said = `${r.stdout}${r.stderr}`;
  assert.equal(r.exit, 0, said.slice(0, 400));
  assert.doesNotMatch(said, /unknown project/);
  assert.deepEqual(r.cwdEntries, ['out']);
  assert.match(said, /wrote out\/pack\.json/);
});

test('a command with NO --project still takes the working directory', (t) => {
  // The rule is about a name that resolves to nothing, not about the fallback.
  // `estimate` with no flags at all must still describe where it is standing.
  const r = runIsolated(t, ['estimate']);
  const said = `${r.stdout}${r.stderr}`;
  assert.equal(r.exit, 0, said.slice(0, 400));
  assert.match(said, /the current directory/);
});
