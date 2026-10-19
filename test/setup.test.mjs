import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sqlglotPin } from '../src/core/sql_requirements.mjs';
import { requiredSqlglot, replaceManagedVenv } from '../src/cli/sql-install.mjs';
import { run as setup } from '../src/cli/commands/setup.mjs';
import { venvPython } from '../src/core/paths.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PIN = requiredSqlglot(ROOT);

// Real filesystem transitions, injected process boundaries: no shell fixtures,
// platform-specific executable format, network, or mutation of the host Python.
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-setup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  const target = path.join(home, 'venv');
  const log = path.join(dir, 'log');
  const registry = path.join(home, 'registry.json');
  const pack = path.join(home, 'projects', 'demo', 'pack', 'manifest.json');
  fs.mkdirSync(path.dirname(pack), { recursive: true });
  fs.writeFileSync(registry, 'registry sentinel');
  fs.writeFileSync(pack, 'pack sentinel');
  function interpreter(location, version) {
    fs.mkdirSync(path.dirname(location), { recursive: true });
    fs.writeFileSync(location, 'interpreter sentinel');
    if (version !== undefined) fs.writeFileSync(path.join(path.dirname(location), 'version'), version);
  }
  function run(flags = [], extra = {}) {
    const env = { CASCADE_HOME: home, CASCADE_PYTHON3: 'builder', ...extra };
    const r = { status: null, stdout: '', stderr: '' };
    const stopped = new Error('command stopped');
    try {
      setup({
        flag: (name) => name === 'home' || flags.includes(`--${name}`),
        die: (message) => { r.status = 2; r.stderr = message; throw stopped; },
      }, {
        env, engineRoot: ROOT,
        write: (text) => { r.stdout += text; },
        exit: (code) => { r.status = code; },
        resolvePython: () => ({ ok: fs.existsSync(venvPython(target)), path: venvPython(target), from: 'managed' }),
        probeVersion: (python) => {
          const versionFile = path.join(path.dirname(python), 'version');
          return fs.existsSync(python) && fs.existsSync(versionFile)
            ? { ok: true, version: fs.readFileSync(versionFile, 'utf8') }
            : { ok: false, error: 'No module named sqlglot' };
        },
        execute: (file, args) => {
          if (args[0] === '-c') return Buffer.from('3.12');
          if (args[1] === 'venv') {
            assert.equal(file, 'builder');
            assert.equal(args[2], target, 'venv is built at its final absolute path');
            fs.appendFileSync(log, 'venv\n');
            if (extra.FAKE_VENV_FAIL) throw new Error('venv failed');
            interpreter(venvPython(target));
            return Buffer.from('');
          }
          assert.equal(file, venvPython(target));
          assert.equal(args[1], 'pip');
          assert.equal(args.at(-1), path.join(ROOT, 'adapters/sql/requirements.txt'));
          fs.appendFileSync(log, 'pip\n');
          if (extra.FAKE_PIP_FAIL) throw new Error('network unavailable');
          fs.writeFileSync(path.join(path.dirname(file), 'version'), extra.FAKE_INSTALLED || PIN);
          return Buffer.from('');
        },
      });
    } catch (e) { if (e !== stopped) throw e; }
    assert.equal(fs.readFileSync(registry, 'utf8'), 'registry sentinel');
    assert.equal(fs.readFileSync(pack, 'utf8'), 'pack sentinel');
    assert.deepEqual(fs.readdirSync(home).filter((p) => p.startsWith('.cascade-venv-backup-')), []);
    return r;
  }
  return { dir, home, target, log, interpreter, run };
}

test('requirements pin parsing ignores optional comments and rejects absent or ambiguous pins', () => {
  assert.equal(sqlglotPin('# sqlglot==old\nsqlglot==30.17.0\n'), '30.17.0');
  for (const text of ['', 'sqlglot>=30', 'sqlglot==1\nsqlglot==2']) {
    assert.throws(() => sqlglotPin(text), /exactly one/);
  }
});

test('a matching managed environment is reused without creating or installing', (t) => {
  const f = fixture(t);
  f.interpreter(venvPython(f.target), PIN);
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /already set up/);
  assert.equal(fs.existsSync(f.log), false);
});

test('wrong or missing sqlglot is repaired; --force reinstalls a matching environment', (t) => {
  for (const [version, flags] of [['0.0.1', []], [undefined, []], [PIN, ['--force']]]) {
    const f = fixture(t);
    f.interpreter(venvPython(f.target), version);
    fs.writeFileSync(path.join(f.target, 'old-marker'), 'old');
    const r = f.run(flags);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /ready:/);
    assert.equal(fs.readFileSync(path.join(path.dirname(venvPython(f.target)), 'version'), 'utf8'), PIN);
    assert.equal(fs.existsSync(path.join(f.target, 'old-marker')), false);
    assert.equal(fs.readFileSync(f.log, 'utf8'), 'venv\npip\n');
  }
});

test('pip and post-install validation failures restore the old environment and fail', (t) => {
  for (const extra of [{ FAKE_VENV_FAIL: '1' }, { FAKE_PIP_FAIL: '1' }, { FAKE_INSTALLED: '0.0.1' }]) {
    const f = fixture(t);
    f.interpreter(venvPython(f.target), '0.0.2');
    const marker = path.join(f.target, 'old-marker');
    fs.writeFileSync(marker, 'keep me');
    const r = f.run(['--force'], extra);
    assert.notEqual(r.status, 0);
    assert.doesNotMatch(r.stdout, /ready:/);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'keep me');
    assert.equal(fs.readFileSync(path.join(path.dirname(venvPython(f.target)), 'version'), 'utf8'), '0.0.2');
  }
});

test('a fresh installation failure removes the failed environment', (t) => {
  const f = fixture(t);
  assert.notEqual(f.run([], { FAKE_PIP_FAIL: '1' }).status, 0);
  assert.equal(fs.existsSync(f.target), false);
});

test('CASCADE_PYTHON is never modified, including with --force', (t) => {
  for (const version of [PIN, '0.0.1', undefined]) {
    const f = fixture(t);
    const external = venvPython(path.join(f.dir, 'external'));
    f.interpreter(external, version);
    const before = fs.readFileSync(external, 'utf8');
    const r = f.run(['--force'], { CASCADE_PYTHON: external });
    assert.equal(r.status, version === PIN ? 0 : 2, r.stderr);
    assert.equal(fs.readFileSync(external, 'utf8'), before);
    assert.equal(fs.existsSync(f.target), false);
    assert.equal(fs.existsSync(f.log), false);
    if (version !== PIN) assert.match(r.stderr, /unset CASCADE_PYTHON/);
  }
});

test('managed replacement builds at the final path and restores on builder failure', (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.target);
  fs.writeFileSync(path.join(f.target, 'original'), 'old');
  assert.throws(() => replaceManagedVenv(f.target, () => {
    assert.equal(fs.existsSync(f.target), false);
    fs.mkdirSync(f.target);
    fs.writeFileSync(path.join(f.target, 'partial'), 'new');
    throw new Error('builder failed');
  }), /builder failed/);
  assert.deepEqual(fs.readdirSync(f.target), ['original']);
});

test('failed rollback preserves the backup and reports its recovery location', (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.target);
  fs.writeFileSync(path.join(f.target, 'original'), 'recover me');
  const rename = fs.renameSync;
  let backup;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === f.target) { backup = from; throw new Error('restore denied'); }
    return rename(from, to);
  });
  assert.throws(() => replaceManagedVenv(f.target, () => {
    throw new Error('installation failed');
  }), /installation failed; rollback failed: restore denied.*Previous environment preserved/);
  assert.equal(fs.readFileSync(path.join(backup, 'original'), 'utf8'), 'recover me');
});

