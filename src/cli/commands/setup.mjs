// setup.mjs — `cascade setup`: build the SQL lane's interpreter, in one command.
//
// The lane is a Python program, and until now the only way to get one was to
// read a setup page and type two commands with the right working directory.
// That is a documentation exercise standing between a reader and their first
// answer, so this does it: find a python3, build the virtual environment where
// the resolver will look for it, install the PINNED requirements, and then
// PROVE it by importing sqlglot rather than trusting that pip said ok.
//
// It never touches a system interpreter's packages: everything goes inside the
// environment it creates; mismatched managed environments are repaired.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sqlVenvTarget, venvPython } from '../../core/paths.mjs';
import { ENGINE_ROOT, sqlPython } from '../env.mjs';
import { requiredSqlglot, probeSqlglot, replaceManagedVenv } from '../sql-install.mjs';
import { sqlglotMatches } from '../../core/sql_requirements.mjs';

export function run(ctx, io = {}) {
  const { flag, die } = ctx;
  // Process edges are injectable so repair and rollback can be tested on every
  // platform without launching executable fixtures or downloading packages.
  const execute = io.execute ?? execFileSync;
  const probeVersion = io.probeVersion ?? probeSqlglot;
  const write = io.write ?? ((text) => process.stdout.write(text));
  const exit = io.exit ?? ((code) => process.exit(code));
  const env = io.env ?? process.env;
  const engineRoot = io.engineRoot ?? ENGINE_ROOT;
  const resolvePython = io.resolvePython ?? sqlPython;
  const isCheckout = fs.existsSync(path.join(engineRoot, '.git'));
  const target = flag('home')
    ? sqlVenvTarget({ engineRoot, env, isCheckout: false })
    : sqlVenvTarget({ engineRoot, env, isCheckout });
  const targetPy = venvPython(target);
  const req = path.join(engineRoot, 'adapters', 'sql', 'requirements.txt');

  const expectedVersion = requiredSqlglot(engineRoot);
  if (env.CASCADE_PYTHON) {
    const probe = probeVersion(env.CASCADE_PYTHON);
    if (!sqlglotMatches(probe, expectedVersion)) {
      die(`CASCADE_PYTHON selects ${env.CASCADE_PYTHON}: ${probe.error || `sqlglot ${probe.version || 'version unknown'}`}; required sqlglot ${expectedVersion}. `
        + `Install sqlglot==${expectedVersion} into that interpreter yourself, or unset CASCADE_PYTHON and run \`cascade setup\`. The override was not modified.`);
      return;
    }
    write(`the SQL lane is already set up: ${env.CASCADE_PYTHON} (CASCADE_PYTHON), sqlglot ${probe.version}\n`);
    return exit(0);
  }

  // Reuse only the pinned version, even when the interpreter can import it.
  const probe = probeVersion(targetPy);
  if (sqlglotMatches(probe, expectedVersion) && !flag('force')) {
    write(`the SQL lane is already set up: ${targetPy}, sqlglot ${probe.version}\n`);
    write('pass --force to build it again\n');
    const selected = resolvePython();
    if (selected.ok && path.resolve(selected.path) !== path.resolve(targetPy)) {
      write(`note: a run will still prefer ${selected.path} (${selected.from}), which comes first\n`);
    }
    return exit(0);
  }

  const base = findBasePython({ env, execute });
  if (!base) {
    return die('no python3 on PATH to build the SQL lane with. Install one (macOS: `brew install python`; Debian or Ubuntu: `sudo apt-get install python3 python3-venv`), '
      + 'or set CASCADE_PYTHON to an interpreter that already has sqlglot and skip this command');
  }

  write(`building ${target} with ${base.cmd} (python ${base.version})…\n`);
  let version;
  try {
    version = buildPinnedEnvironment({ target, targetPy, req, expectedVersion, engineRoot, base }, { execute, write, probeVersion });
  } catch (e) {
    die(`${e.message}. Setup failed; any previous managed environment was restored unless rollback failed as reported above.`);
    return;
  }
  const now = resolvePython();
  write(`ready: ${targetPy}, sqlglot ${version}\n`);
  if (now.ok && path.resolve(now.path) !== path.resolve(targetPy)) {
    write(`note: a run will still prefer ${now.path} (${now.from}), which comes first\n`);
  }
  write('next: `cascade doctor` to check every prerequisite, then `cascade init --root <your project>`\n');
  exit(0);
}


function findBasePython({ env, execute }) {
  // A Python to build with; probing a candidate does not mutate its packages.
  for (const cmd of [env.CASCADE_PYTHON3, 'python3', 'python'].filter(Boolean)) {
    try {
      const version = execute(cmd, ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], {
        stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000,
      }).toString('utf8').trim();
      if (/^3\.(\d+)$/.test(version)) return { cmd, version };
    } catch { /* try the next spelling */ }
  }
  return null;
}

function buildPinnedEnvironment({ target, targetPy, req, expectedVersion, engineRoot, base }, { execute, write, probeVersion }) {
  let version;
  replaceManagedVenv(target, () => {
    try {
      execute(base.cmd, ['-m', 'venv', target], { stdio: ['ignore', 'inherit', 'inherit'], timeout: 60000 });
    } catch (e) {
      throw new Error(`could not create a virtual environment at ${target}: ${e.message}. On Debian or Ubuntu install python3-venv`, { cause: e });
    }
    write(`installing ${path.relative(engineRoot, req)}…\n`);
    try {
      execute(targetPy, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', req], {
        stdio: ['ignore', 'inherit', 'inherit'], timeout: 180000,
      });
    } catch (e) {
      throw new Error(`the requirements did not install into ${target}: ${e.message}`, { cause: e });
    }
    const installed = probeVersion(targetPy);
    if (!sqlglotMatches(installed, expectedVersion)) {
      throw new Error(`${targetPy}: ${installed.error || `sqlglot ${installed.version || 'version unknown'}`}; required sqlglot ${expectedVersion}`);
    }
    version = installed.version;
  });
  return version;
}
