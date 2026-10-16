import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/cascade.mjs', import.meta.url));

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-code-cli-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'repo'), pack = path.join(dir, 'pack');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(root, 'src', 'orders.js'), "export function loadOrders() { return fetch('/orders'); }\n");
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  git('init', '-q'); git('add', '.'); git('-c', 'user.email=dev@example.com', '-c', 'user.name=dev', 'commit', '-qm', 'initial');
  const invoke = (...args) => spawnSync(process.execPath, [CLI, ...args], {
    cwd: root, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, CASCADE_HOME: path.join(dir, 'home'), CASCADE_CACHE_DIR: path.join(dir, 'cache') },
  });
  const initial = invoke('analyze', '--root', root, '--out', pack, '--web-src', 'src', '--no-java', '--no-ddl', '--no-mappers', '--no-ts', '--no-openapi');
  assert.equal(initial.status, 0, initial.stderr);
  const query = (action, ...args) => {
    const result = invoke('code', action, '--pack', pack, ...args);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const readPack = () => JSON.parse(fs.readFileSync(path.join(pack, 'pack.json'), 'utf8'));
  return { root, pack, git, invoke, query, readPack };
}

test('code CLI refreshes saved changes, additions, deletions and HEAD, and reuses a stable generation across sessions', (t) => {
  const { root, query, readPack, git } = fixture(t);
  const first = query('search', '--query', 'loadOrders');
  assert.ok(first.answer.items.some((x) => x.name === 'loadOrders'));
  assert.equal(first.basis.freshness.verdict, 'current');
  const generation = readPack().meta.builtAt;
  query('architecture');
  const briefing = query('briefing', '--max-bytes', '4096');
  assert.match(briefing.answer.text, /analyzed files/);
  assert.ok(Buffer.byteLength(JSON.stringify(briefing.answer)) <= 4096);
  assert.equal(briefing.answer.freshness.verdict, 'current');
  assert.equal(readPack().meta.builtAt, generation, 'unchanged source reuses persisted refresh state');

  fs.writeFileSync(path.join(root, 'src', 'orders.js'), "export function loadCustomers() { return fetch('/customers'); }\n");
  const changed = query('search', '--query', 'loadCustomers');
  assert.ok(changed.answer.items.some((x) => x.name === 'loadCustomers'));
  assert.equal(changed.basis.freshness.verdict, 'current');
  assert.equal(query('search', '--query', 'loadOrders').answer.items.length, 0);
  const snippet = query('snippet', '--file', 'src/orders.js', '--from-line', '1', '--to-line', '1');
  assert.match(snippet.answer.snippet, /loadCustomers/);

  fs.writeFileSync(path.join(root, 'src', 'extra.js'), 'export function addedLater() { return 1; }\n');
  assert.ok(query('search', '--query', 'addedLater').answer.items.some((x) => x.name === 'addedLater'));
  fs.unlinkSync(path.join(root, 'src', 'extra.js'));
  assert.equal(query('search', '--query', 'addedLater').answer.items.length, 0);
  git('add', '.'); git('-c', 'user.email=dev@example.com', '-c', 'user.name=dev', 'commit', '-qm', 'rename');
  query('architecture');
  assert.equal(readPack().meta.base.commit, git('rev-parse', 'HEAD'));
  const context = query('context', '--query', 'loadCustomers', '--max-bytes', '1024');
  assert.ok(Buffer.byteLength(JSON.stringify(context.answer)) <= 1024);
});

test('snapshot mode does not rebuild and refuses source bytes that no longer match the index', (t) => {
  const { root, pack, query, readPack, invoke } = fixture(t);
  query('search', '--query', 'loadOrders');
  const generation = readPack().meta.builtAt;
  fs.writeFileSync(path.join(root, 'src', 'orders.js'), 'export function changed() {}\n');
  const old = query('search', '--query', 'loadOrders', '--no-watch');
  assert.ok(old.answer.items.some((x) => x.name === 'loadOrders'));
  assert.equal(old.basis.freshness.verdict, 'unknown');
  assert.equal(readPack().meta.builtAt, generation);
  const result = invoke('code', 'snippet', '--pack', pack, '--file', 'src/orders.js', '--no-watch');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /stale-source/);
});
