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
// environment it creates, and `--force` is the only way to replace one.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sqlVenvTarget } from '../../core/paths.mjs';
import { ENGINE_ROOT, sqlPython } from '../env.mjs';

export function run(ctx) {
  const { flag, die } = ctx;
  const already = sqlPython();
  const isCheckout = fs.existsSync(path.join(ENGINE_ROOT, '.git'));
  const target = flag('home')
    ? sqlVenvTarget({ engineRoot: ENGINE_ROOT, isCheckout: false })
    : sqlVenvTarget({ engineRoot: ENGINE_ROOT, isCheckout });
  const targetPy = path.join(target, 'bin', 'python');
  const req = path.join(ENGINE_ROOT, 'adapters', 'sql', 'requirements.txt');

  const sqlglotVersion = (py) => {
    try {
      return execFileSync(py, ['-c', 'import sqlglot; print(sqlglot.__version__)'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8').trim();
    } catch { return null; }
  };

  // Already done means: the interpreter a run would PICK is the one this
  // command would build, and it works. `--home` naming a different place, or a
  // resolved candidate that is not the target, is a reason to build.
  const targetIsWhatRunsWould = already.ok && path.resolve(already.path) === path.resolve(targetPy);
  if (targetIsWhatRunsWould && !flag('force')) {
    const v = sqlglotVersion(already.path);
    if (v) {
      process.stdout.write(`the SQL lane is already set up: ${already.path} (${already.from}), sqlglot ${v}\n`);
      process.stdout.write('pass --force to build it again\n');
      process.exit(0);
    }
    process.stdout.write(`${already.path} exists but cannot import sqlglot, so it is being rebuilt\n`);
  }

  // A python3 to build WITH. Never the one being built.
  let base = null;
  for (const cand of [process.env.CASCADE_PYTHON3, 'python3', 'python'].filter(Boolean)) {
    try {
      const v = execFileSync(cand, ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8').trim();
      if (/^3\.(\d+)$/.test(v)) { base = { cmd: cand, version: v }; break; }
    } catch { /* try the next spelling */ }
  }
  if (!base) {
    die('no python3 on PATH to build the SQL lane with. Install one (macOS: `brew install python`; Debian or Ubuntu: `sudo apt-get install python3 python3-venv`), '
      + 'or set CASCADE_PYTHON to an interpreter that already has sqlglot and skip this command');
  }

  if (flag('force') && fs.existsSync(target)) {
    process.stdout.write(`removing ${target}\n`);
    fs.rmSync(target, { recursive: true, force: true });
  }
  process.stdout.write(`building ${target} with ${base.cmd} (python ${base.version})…\n`);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    execFileSync(base.cmd, ['-m', 'venv', target], { stdio: ['ignore', 'inherit', 'inherit'] });
  } catch (e) {
    die(`could not create a virtual environment at ${target}: ${(e && e.message) || e}. `
      + 'On Debian or Ubuntu the venv module ships separately: `sudo apt-get install python3-venv`');
  }
  process.stdout.write(`installing ${path.relative(ENGINE_ROOT, req)}…\n`);
  try {
    execFileSync(path.join(target, 'bin', 'pip'), ['install', '--disable-pip-version-check', '-r', req], { stdio: ['ignore', 'inherit', 'inherit'] });
  } catch (e) {
    die(`the requirements did not install into ${target}: ${(e && e.message) || e}`);
  }

  // Proof, not a claim: the lane's own import, run by the interpreter a run
  // will actually use.
  const version = sqlglotVersion(targetPy);
  if (!version) die(`${targetPy} was built but cannot import sqlglot. Try \`cascade setup --force\`, and see docs/setup/sql-lane.md`);
  const now = sqlPython();
  process.stdout.write(`ready: ${targetPy}, sqlglot ${version}\n`);
  if (now.ok && path.resolve(now.path) !== path.resolve(targetPy)) {
    process.stdout.write(`note: a run will still prefer ${now.path} (${now.from}), which comes first\n`);
  }
  process.stdout.write('next: `cascade doctor` to check every prerequisite, then `cascade init --root <your project>`\n');
  process.exit(0);
}
