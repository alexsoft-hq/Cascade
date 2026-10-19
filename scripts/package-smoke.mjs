#!/usr/bin/env node
// Exercise exactly the package a user installs, outside every checkout cache.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { npmCli } from '../src/packaging/npm_cli.mjs';
import { readPackageTarball, validatePackageFiles } from '../src/packaging/package_smoke.mjs';

const checkout = fileURLToPath(new URL('../', import.meta.url));
const options = {};
for (let i = 2; i < process.argv.length; i++) {
  const flag = process.argv[i];
  if (flag === '--keep') options.keep = true;
  else if (['--tarball', '--expected-version'].includes(flag) && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) options[flag.slice(2)] = process.argv[++i];
  else throw new Error(`Unknown or incomplete argument: ${flag}`);
}
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-package-smoke-')));
const work = path.join(root, 'work'), prefix = path.join(root, 'prefix');
fs.mkdirSync(work); fs.mkdirSync(prefix);
const env = { ...process.env };
// npm/pip/Python and git settings can silently make an isolated run use the
// developer's interpreter, import paths, package cache or repository instead.
for (const key of Object.keys(env)) {
  if (/^(CASCADE_|PYTHON|PIP_|VIRTUAL_ENV$|CONDA_|NODE_PATH$|NODE_OPTIONS$|NPM_CONFIG_|npm_config_|GIT_CONFIG_|GIT_DIR$|GIT_WORK_TREE$|GIT_INDEX_FILE$|GIT_OBJECT_DIRECTORY$|GIT_ALTERNATE_OBJECT_DIRECTORIES$)/i.test(key)) delete env[key];
}
Object.assign(env, {
  CASCADE_HOME: path.join(root, 'cascade-home'), XDG_CACHE_HOME: path.join(root, 'xdg-cache'),
  npm_config_cache: path.join(root, 'npm-cache'), npm_config_userconfig: path.join(root, 'npmrc'),
  npm_config_globalconfig: path.join(root, 'global-npmrc'), PIP_CACHE_DIR: path.join(root, 'pip-cache'),
  GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
  PYTHONNOUSERSITE: '1', PIP_CONFIG_FILE: process.platform === 'win32' ? 'NUL' : '/dev/null',
});
const checkoutReal = fs.realpathSync.native(checkout);
// Keep system toolchains, but never a checkout's local executables or a
// preactivated virtual environment. Invoke the installed CLI by absolute path.
const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
env[pathKey] = (env[pathKey] ?? '').split(path.delimiter).filter((entry) => {
  if (!entry) return false;
  const absolute = path.resolve(entry);
  return !(absolute === checkoutReal || absolute.startsWith(checkoutReal + path.sep) || /[\\/](?:\.venv|venv|node_modules)[\\/]/i.test(absolute + path.sep));
}).join(path.delimiter);
fs.writeFileSync(env.GIT_CONFIG_GLOBAL, '');
fs.writeFileSync(env.npm_config_userconfig, ''); fs.writeFileSync(env.npm_config_globalconfig, '');
const log = (stage, details = {}) => console.log(JSON.stringify({ stage, ...details }));

const npm = npmCli();
function run(command, args, { cwd = work, timeout = 120_000, status = 0, windowsVerbatimArguments = false, envOverrides = {} } = {}) {
  const result = spawnSync(command, args, { cwd, env: { ...env, ...envOverrides }, encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true, windowsVerbatimArguments });
  if (result.error || result.status !== status) throw new Error(`${command} ${args.join(' ')} failed (exit ${result.status}): ${result.error?.message ?? ''}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  return result;
}
const npmRun = (args, opts) => run(process.execPath, [npm, ...args], opts);

// A real failing pip transaction must leave the working managed environment
// intact, and a later successful force must replace only that environment.
function checkSetupRecovery(cascade) {
  const venv = path.join(env.CASCADE_HOME, 'venv');
  const marker = path.join(venv, 'package-smoke-marker');
  const sentinel = path.join(env.CASCADE_HOME, 'package-smoke-sentinel');
  fs.writeFileSync(marker, 'existing environment');
  fs.writeFileSync(sentinel, 'outside managed environment');
  const reused = cascade(['setup', '--home'], { timeout: 300_000 });
  assert.match(reused.stdout, /already set up/);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'existing environment');
  const failed = cascade(['setup', '--home', '--force'], {
    timeout: 300_000, status: 2, envOverrides: { PIP_NO_INDEX: '1', PIP_FIND_LINKS: undefined },
  });
  assert.match(failed.stderr, /requirements did not install|Setup failed/);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'existing environment', 'Failed force lost previous venv');
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'outside managed environment');
  const recovered = JSON.parse(cascade(['doctor', '--json']).stdout);
  assert.equal(recovered.ok, true, 'Doctor failed after forced setup rollback');
  for (const check of recovered.checks.filter((c) => c.required)) assert.equal(check.status, 'ok', JSON.stringify(check));
  const replaced = cascade(['setup', '--home', '--force'], { timeout: 300_000 });
  assert.match(replaced.stdout, /ready:/);
  assert.equal(fs.existsSync(marker), false, 'Successful force reused the previous venv');
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'outside managed environment');
  log('setup-recovery', { reuse: 'preserved marker', offlineForceExit: 2, rollback: 'previous environment healthy', force: 'replaced environment', outsideSentinel: 'preserved' });
}

async function checkMcp(cli, version, pack, project) {
  const child = spawn(process.execPath, [cli, 'mcp', '--pack', pack], { cwd: work, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const pending = new Map();
  let buffer = '', stderr = '', id = 0;
  let protocolError = null, closing = false;
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const fail = (error) => { protocolError = error; for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); } pending.clear(); };
  child.on('error', fail);
  child.stdin.on('error', fail);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      try {
        const response = JSON.parse(line);
        assert.equal(response.jsonrpc, '2.0');
        const request = pending.get(response.id);
        assert.ok(request, `Unexpected RPC response id: ${response.id}`);
        pending.delete(response.id); clearTimeout(request.timer);
        if (response.error) request.reject(new Error(JSON.stringify(response.error)));
        else request.resolve(response.result);
      } catch (error) { fail(error); child.kill(); }
    }
  });
  const closed = new Promise((resolve, reject) => {
    child.once('close', (code, signal) => {
      if (!closing || pending.size) fail(new Error(`MCP exited before normal shutdown: ${code}/${signal}\n${stderr}`));
      resolve({ code, signal });
    });
    child.once('error', reject);
  });
  async function rpc(method, params) {
    if (protocolError) throw protocolError;
    const requestId = ++id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`MCP deadline: ${method}\n${stderr}`)); child.kill(); }, 60_000);
      pending.set(requestId, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
    });
  }
  async function call(name, args = {}) {
    const result = await rpc('tools/call', { name, arguments: args });
    assert.ok(!result.isError, `${name}: ${JSON.stringify(result)}`);
    const value = JSON.parse(result.content.find((c) => c.type === 'text').text);
    for (const field of ['answer', 'basis', 'trust', 'limits', 'truncated']) assert.ok(field in value, `${name} missing ${field}`);
    return value;
  }
  try {
    const initialized = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'package-smoke', version: '1' } });
    assert.equal(initialized.serverInfo.version, version);
    assert.ok(initialized.capabilities.tools);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const listed = await rpc('tools/list', {});
    for (const name of ['projects', 'overview', 'code_search', 'search']) assert.ok(listed.tools.some((t) => t.name === name), `Missing MCP tool: ${name}`);
    const projects = await call('projects');
    assert.ok(projects.answer.projects.some((p) => p.id === project), JSON.stringify(projects.answer));
    const overview = await call('overview', { project });
    assert.ok(overview.answer && Object.keys(overview.answer).length);
    const java = await call('code_search', { project, query: 'SmokeController', kind: 'declaration' });
    assert.ok(java.answer.items.some((item) => item.name === 'SmokeController'), JSON.stringify(java.answer));
    const ts = await call('code_search', { project, query: 'HealthController', kind: 'declaration' });
    assert.ok(ts.answer.items.some((item) => item.name === 'HealthController'), JSON.stringify(ts.answer));
    const sql = await call('search', { project, query: 'smoke_items' });
    assert.match(JSON.stringify(sql.answer), /smoke_items/);
    log('mcp', { tools: listed.tools.length, project, version });
    closing = true;
    child.stdin.end();
    const exit = await Promise.race([closed, new Promise((_, reject) => { const timer = setTimeout(() => { child.kill(); reject(new Error('MCP normal shutdown deadline')); }, 15_000); timer.unref(); })]);
    assert.equal(exit.code, 0, stderr); assert.equal(buffer, ''); assert.equal(protocolError, null);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    for (const request of pending.values()) clearTimeout(request.timer);
  }
}

try {
  log('environment', { os: os.platform(), arch: os.arch(), node: process.version, npm: npmRun(['--version']).stdout.trim(), temp: root });
  let tarball;
  if (options.tarball) tarball = fs.realpathSync.native(path.resolve(options.tarball));
  else {
    const pkg = JSON.parse(fs.readFileSync(path.join(checkout, 'package.json')));
    const lock = JSON.parse(fs.readFileSync(path.join(checkout, 'package-lock.json')));
    for (const field of ['name', 'version']) {
      assert.equal(lock[field], pkg[field], `package-lock root ${field}`);
      assert.equal(lock.packages?.['']?.[field], pkg[field], `package-lock packages[''] ${field}`);
    }
    const packed = JSON.parse(npmRun(['pack', '--json', '--ignore-scripts', '--pack-destination', root], { cwd: checkout }).stdout);
    assert.equal(packed.length, 1); tarball = path.join(root, packed[0].filename);
  }
  const tarballBytes = fs.readFileSync(tarball);
  const artifact = readPackageTarball(tarballBytes);
  const metadata = validatePackageFiles([...artifact.files.keys()], artifact.pkg, options['expected-version']);
  log('tarball', { ...metadata, tarball, sha256: createHash('sha256').update(tarballBytes).digest('hex') });
  npmRun(['install', '--prefix', prefix, '--no-audit', '--no-fund', '--ignore-scripts', '--package-lock=false', tarball]);
  const installed = path.join(prefix, 'node_modules', ...metadata.name.split('/'));
  const cli = fs.realpathSync.native(path.join(installed, 'bin', 'cascade.mjs'));
  assert.ok(cli.startsWith(fs.realpathSync.native(prefix) + path.sep), 'Installed executable escaped prefix');
  const shim = path.join(prefix, 'node_modules', '.bin', process.platform === 'win32' ? 'cascade.cmd' : 'cascade');
  assert.ok(fs.existsSync(shim), 'npm executable shim missing');
  const launcher = process.platform === 'win32'
    ? run(env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `""${shim}" --version"`], { windowsVerbatimArguments: true })
    : run(shim, ['--version']);
  assert.equal(launcher.stdout.trim(), metadata.version, 'Installed npm launcher version');
  const installedPkg = JSON.parse(fs.readFileSync(path.join(installed, 'package.json')));
  assert.equal(installedPkg.version, metadata.version); assert.equal(installedPkg.name, metadata.name);
  assert.equal(fs.existsSync(path.join(installed, '.venv')), false);
  const cascade = (args, opts) => run(process.execPath, [cli, ...args], opts);
  assert.equal(cascade(['--version']).stdout.trim(), metadata.version);
  const help = cascade(['--help'], { status: 2 }); assert.match(help.stderr, /usage: cascade/);
  const analyzeHelp = cascade(['analyze', '--help']); assert.match(analyzeHelp.stdout, /cascade analyze/);
  log('cli', { version: metadata.version, rootHelpExit: 2, analyzeHelpExit: 0 });
  const setup = cascade(['setup', '--home'], { timeout: 300_000 });
  log('setup', { stdout: setup.stdout.trim(), stderr: setup.stderr.trim() });
  checkSetupRecovery(cascade);
  const doctor = JSON.parse(cascade(['doctor', '--json']).stdout);
  assert.equal(doctor.ok, true); assert.ok(doctor.checks.filter((c) => c.required).length >= 7);
  for (const check of doctor.checks.filter((c) => c.required)) assert.equal(check.status, 'ok', JSON.stringify(check));
  assert.match(doctor.checks.find((c) => c.id === 'python-venv').detail, new RegExp('cascade-home'));
  log('doctor', { required: doctor.checks.filter((c) => c.required) });
  const fixture = path.join(work, 'fixture');
  fs.cpSync(path.join(checkout, 'test/fixtures/package-smoke'), fixture, { recursive: true });
  run('git', ['init', '-q'], { cwd: fixture }); run('git', ['add', '-A'], { cwd: fixture });
  run('git', ['-c', 'user.name=Package Smoke', '-c', 'user.email=smoke@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Package smoke fixture'], { cwd: fixture });
  const initialized = cascade(['init', '--root', fixture, '--project', 'package-smoke', '--json']);
  assert.equal(JSON.parse(initialized.stdout).project, 'package-smoke');
  log('init', { project: 'package-smoke' });
  const pack = path.join(fixture, '.cascade', 'pack');
  const analyzed = cascade(['analyze', '--root', fixture, '--project', 'package-smoke', '--ddl', path.join(fixture, 'schema.sql'), '--mappers', path.join(fixture, 'mappers'), '--java-src', path.join(fixture, 'java'), '--ts-src', path.join(fixture, 'backend'), '--web-src', path.join(fixture, 'web')], { timeout: 300_000 });
  const output = JSON.parse(fs.readFileSync(path.join(pack, 'pack.json')));
  for (const lane of ['sql', 'java', 'ts', 'web']) assert.ok(output.meta.lanes.includes(lane), `Missing analysis lane ${lane}: ${JSON.stringify(output.meta)}\n${analyzed.stderr}`);
  assert.ok(output.nodes.some((n) => /smoke_items/.test(n.id)), 'DDL/SQL fixture missing from pack');
  assert.ok(output.nodes.some((n) => n.kind === 'symbol' && n.file?.endsWith('SmokeController.java')), 'Java produced no nodes');
  assert.ok(output.nodes.some((n) => n.lane === 'ts'), 'TypeScript produced no nodes');
  assert.ok(output.nodes.some((n) => n.lane === 'web'), 'Web produced no nodes');
  assert.equal(output.meta.laneStats.parseErrors, 0, 'Java parser errors');
  assert.equal(output.meta.laneStats.web.parseErrors, 0, 'Web parser errors');
  assert.ok(output.meta.laneStats.ts.routes > 0, 'TypeScript produced no route');
  assert.ok(output.meta.laneStats.web.callsWithUrl > 0, 'Web produced no HTTP call');
  assert.ok(output.nodes.some((n) => n.kind === 'statement'), 'SQL produced no statement');
  log('analyze', { lanes: output.meta.lanes, nodes: output.nodes.length, stderr: analyzed.stderr.trim() });
  await checkMcp(cli, metadata.version, pack, 'package-smoke');
  log('passed', { version: metadata.version, os: os.platform(), arch: os.arch() });
} catch (error) {
  log('failed', { error: error.stack, temp: root }); process.exitCode = 1;
} finally {
  if (options.keep) log('kept', { temp: root });
  else fs.rmSync(root, { recursive: true, force: true });
}
