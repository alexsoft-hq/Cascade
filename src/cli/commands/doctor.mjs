// doctor.mjs — `cascade doctor`: pre-flight every prerequisite at once.
//
// THIS FILE IS THE IMPURE HALF. It runs the probes — an interpreter, an import,
// a compiler, a parser, a write into the cache directory — and src/core/doctor.mjs
// turns what they said into the table. The pure half is tested with fake probes,
// so the states this machine happens not to be in are covered too.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildDoctorReport, formatDoctorTable, jdkCandidateDirs } from '../../core/doctor.mjs';
import { cacheDir, registryPath } from '../../core/paths.mjs';
import { readRegistry, projectIds } from '../../core/registry.mjs';
import { ENGINE_ROOT, findJdk, sqlPython } from '../env.mjs';

/**
 * Run one probe and report BOTH failure modes apart.
 *
 * A tool that is absent and one that is broken are DIFFERENT answers, and the
 * remedy differs too, so the error text is relayed rather than flattened into
 * "not found". The tool's OWN last line beats node's "Command failed: <the whole
 * command line>", which says nothing and pastes an absolute path into the report.
 */
function runOut(file, args, opts = {}) {
  try {
    return {
      ok: true,
      out: execFileSync(file, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000, ...opts })
        .toString('utf8').trim(),
    };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: false, error: `not found: ${file}` };
    const said = String((e && e.stderr) || '').trim().split('\n').filter(Boolean).pop();
    return { ok: false, error: said || String((e && e.message) || 'failed').split('\n')[0] };
  }
}

/** The SQL lane's interpreter, and a reader for any module inside it. */
function pythonProbes() {
  const pyRes = sqlPython();
  const venvPy = pyRes.path;
  const python = pyRes.ok
    ? (() => { const r = runOut(venvPy, ['-V']); return { path: venvPy, from: pyRes.from, ok: r.ok, version: r.out, error: r.error }; })()
    : { path: venvPy, from: null, ok: false, error: `no interpreter in any of: ${pyRes.tried.map((c) => c.path).join(', ')}` };
  const pyModule = (mod) => {
    if (!python.ok) return { ok: false, error: `no venv python at ${venvPy}` };
    const r = runOut(venvPy, ['-c', `import ${mod}, sys; sys.stdout.write(getattr(${mod}, "__version__", "unknown"))`]);
    return r.ok ? { ok: true, version: r.out } : { ok: false, error: r.error };
  };
  return { python, pyModule };
}

/** Every place a JDK was looked for, which one won, and what it says it is. */
function jdkProbe() {
  const candidates = jdkCandidateDirs(process.env).map(({ dir, via }) => ({
    dir, via,
    javac: fs.existsSync(path.join(dir, 'javac')),
    java: fs.existsSync(path.join(dir, 'java')),
  }));
  const chosen = findJdk();
  const javacV = chosen ? runOut(chosen.javac, ['-version']) : null;
  return { candidates, chosen, version: javacV && javacV.ok ? javacV.out : undefined };
}

/**
 * Can this tool write where it keeps its shards? The probe uses a project id
 * that cannot collide with a real one, so it never writes inside somebody's
 * shard directory.
 */
function cacheProbe() {
  const dir = cacheDir('doctor-probe');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probeFile = path.join(dir, 'write-probe');
    fs.writeFileSync(probeFile, 'ok');
    fs.rmSync(probeFile, { force: true });
    return { path: dir, ok: true };
  } catch (e) {
    return { path: dir, ok: false, error: e.message };
  }
}

/** The home registry: absent, readable, or there and broken. Three answers. */
function registryProbe() {
  const regFile = registryPath();
  if (!fs.existsSync(regFile)) return { path: regFile, exists: false };
  try { return { path: regFile, exists: true, ok: true, projects: projectIds(readRegistry(regFile)).length }; }
  catch (e) { return { path: regFile, exists: true, ok: false, error: e.message }; }
}

/**
 * The web lane's parser: LOADED and USED, not just looked for. A file that is
 * present and broken is the failure mode a stat cannot see.
 */
function webParserProbe() {
  const path_ = path.join(ENGINE_ROOT, 'adapters', 'web', 'vendor', 'babel-parser.cjs');
  try {
    const probe = execFileSync(process.execPath, [
      '-e',
      'const p = require(process.argv[1]); const a = p.parse("const a = 1;", { sourceType: "unambiguous" });'
      + ' process.stdout.write(a.program.body[0].type);',
      path_,
    ], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 }).toString('utf8').trim();
    return probe === 'VariableDeclaration'
      ? { path: path_, ok: true }
      : { path: path_, ok: false, error: `the parser loaded but read \`const a = 1;\` as ${probe || 'nothing'}` };
  } catch (e) {
    const said = String((e && e.stderr) || '').trim().split('\n').filter(Boolean).pop();
    return { path: path_, ok: false, error: said || String((e && e.message) || 'failed').split('\n')[0] };
  }
}

export function run(ctx) {
  const { flag } = ctx;
  const { python, pyModule } = pythonProbes();
  const gitV = runOut('git', ['--version']);
  const dockerV = runOut('docker', ['info', '--format', '{{.ServerVersion}}']);

  const report = buildDoctorReport({
    node: { version: process.version },
    git: { ok: gitV.ok, version: gitV.out, error: gitV.error },
    python,
    sqlglot: pyModule('sqlglot'),
    jdk: jdkProbe(),
    webParser: webParserProbe(),
    drivers: [
      { dialect: 'mysql', module: 'pymysql', pip: 'pymysql', ...pyModule('pymysql') },
      { dialect: 'postgres', module: 'psycopg', pip: 'psycopg[binary]', ...pyModule('psycopg') },
      { dialect: 'oracle', module: 'oracledb', pip: 'oracledb', ...pyModule('oracledb') },
    ],
    docker: { ok: dockerV.ok, version: dockerV.out ? `server ${dockerV.out}` : undefined, error: dockerV.error },
    registry: registryProbe(),
    cache: cacheProbe(),
  });

  if (flag('json')) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  else process.stdout.write(formatDoctorTable(report));
  process.exit(report.ok ? 0 : 1);
}
