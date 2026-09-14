// analyze_lock.test.mjs — the gate judges a run against the baseline as it is when the run holds the project's lock.
//
// Two analyses of one project that both read the sealed baseline before either
// published would both be judged against it, and the later one could seal a
// regression of the earlier. So the baseline is read, the gate evaluated and
// everything written with the project's lock held. Held here by hand: the run
// waits, the baseline is re-sealed meanwhile, and the verdict follows the new
// seal, not the one on disk when the run started.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ENGINE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const CLI = path.join(ENGINE_ROOT, 'bin', 'cascade.mjs');
const VENV_PY = path.join(ENGINE_ROOT, '.venv', 'bin', 'python');
const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };

const SCHEMA = 'CREATE TABLE `shop_item` (\n  `id` bigint(20) NOT NULL,\n  `name` varchar(64) DEFAULT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB;\n';
const MAPPER = '<?xml version="1.0" encoding="UTF-8"?>\n<mapper namespace="com.example.mapper.ItemMapper">\n  <select id="selectById" resultType="java.util.Map">select id, name from shop_item where id = #{id}</select>\n</mapper>\n';

test('a run waiting for the project\'s lock is judged against the baseline sealed while it waited', { timeout: 600000 }, async (t) => {
  if (!fs.existsSync(VENV_PY)) { t.skip(`no venv python at ${VENV_PY}`); return; }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-lock-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const env = { ...process.env, ...GIT_ENV, CASCADE_HOME: path.join(work, 'home'), XDG_CACHE_HOME: path.join(work, 'cache') };
  const repo = path.join(work, 'shop');
  for (const [rel, body] of [['db/schema.sql', SCHEMA], ['src/main/resources/mapper/ItemMapper.xml', MAPPER]]) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), body);
  }
  for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['commit', '-q', '-m', 'one']]) execFileSync('git', ['-C', repo, ...args], { env, stdio: 'ignore' });
  const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, maxBuffer: 1 << 28 });
  assert.equal(cli('init', '--root', repo, '--project', 'shop').status, 0);
  const first = cli('analyze', '--root', repo);
  assert.equal(first.status, 0, first.stderr);

  // Another run of the project holds the lock: this test process stands in for it.
  const dotCascade = path.join(repo, '.cascade');
  const lock = path.join(dotCascade, '.write.lock');
  fs.writeFileSync(lock, String(process.pid));
  const child = spawn(process.execPath, [CLI, 'analyze', '--root', repo], { env });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  t.after(() => { if (child.exitCode === null) child.kill(); });
  for (let i = 0; i < 600 && !stderr.includes('waiting for analyze process'); i += 1) await new Promise((r) => setTimeout(r, 100));
  assert.match(stderr, new RegExp(`waiting for analyze process ${process.pid} \\(running\\), which holds ${lock.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.doesNotMatch(stderr, /^gate:/m, 'the gate has not judged anything while the run waits');

  // Meanwhile that other run seals a baseline this run falls far short of.
  const baselineFile = path.join(dotCascade, 'calibration', 'baseline.json');
  const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
  for (const k of Object.keys(baseline.metrics.counts)) baseline.metrics.counts[k] = (baseline.metrics.counts[k] + 1) * 10;
  fs.writeFileSync(baselineFile, JSON.stringify(baseline, null, 2));
  fs.rmSync(lock);

  const code = await exited;
  assert.equal(code, 3, `judged against the baseline sealed while it waited, the run is rejected:\n${stderr}`);
  assert.match(stderr, /^gate: \S+ -> RED/m);
  assert.equal(fs.existsSync(lock), false, 'the rejected run released the lock before it exited');
});
