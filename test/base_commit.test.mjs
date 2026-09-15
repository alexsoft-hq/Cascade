// base_commit.test.mjs — one project compared with itself at an earlier commit, end to end.
//
// A real git repository with two commits: the second adds a column to the schema
// and a statement that writes it. `cascade init` gives it a manifest and a
// profile, and each commit gets a certified analyze. Then the checks a reviewer
// relies on: the earlier build is kept, `cascade diff --base-commit HEAD~1` finds
// it, the same diff built from the repository in a temporary worktree says the
// same thing, the base really reads the OLD schema, the worktree is gone
// afterwards and nothing was registered, and a pack of another repository is
// refused.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadHistoryPack } from '../src/cli/pack_history.mjs';
import { sqlLaneVenv } from './helpers/lane_prereqs.mjs';

const ENGINE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const CLI = path.join(ENGINE_ROOT, 'bin', 'cascade.mjs');
const VENV_PY = sqlLaneVenv().python; // the CLI's own candidate list, so the skip guards the place the run will look in
const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...GIT_ENV } }).toString('utf8');

const SCHEMA_1 = 'CREATE TABLE `shop_item` (\n  `id` bigint(20) NOT NULL,\n  `name` varchar(64) DEFAULT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB;\n';
const SCHEMA_2 = 'CREATE TABLE `shop_item` (\n  `id` bigint(20) NOT NULL,\n  `name` varchar(64) DEFAULT NULL,\n  `stock` int(11) DEFAULT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB;\n';
const mapper = (extra) => `<?xml version="1.0" encoding="UTF-8"?>\n<mapper namespace="com.example.mapper.ItemMapper">\n  <select id="selectById" resultType="java.util.Map">select id, name from shop_item where id = #{id}</select>\n${extra}</mapper>\n`;
const STOCK = '  <update id="restock">update shop_item set stock = #{stock} where id = #{id}</update>\n';

function write(repo, rel, body) {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), body);
}

function setup(t) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-basecommit-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const env = { ...process.env, CASCADE_HOME: path.join(work, 'home'), XDG_CACHE_HOME: path.join(work, 'cache') };
  const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, maxBuffer: 1 << 28 });
  cli.from = (cwd, ...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, cwd, maxBuffer: 1 << 28 });
  const repo = path.join(work, 'shop');
  write(repo, 'db/schema.sql', SCHEMA_1);
  write(repo, 'src/main/resources/mapper/ItemMapper.xml', mapper(''));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'one');
  return { work, env, cli, repo };
}

test('a project compared with its own earlier commit: from its history, and built from the repository, alike', { timeout: 600000 }, (t) => {
  if (!fs.existsSync(VENV_PY)) { t.skip(`no venv python at ${VENV_PY}`); return; }
  const { work, cli, repo } = setup(t);
  const ok = (r) => { assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`); return r; };
  ok(cli('init', '--root', repo, '--project', 'shop'));
  ok(cli('analyze', '--root', repo));
  write(repo, 'db/schema.sql', SCHEMA_2);
  write(repo, 'src/main/resources/mapper/ItemMapper.xml', mapper(STOCK));
  git(repo, 'add', 'db', 'src');
  git(repo, 'commit', '-q', '-m', 'two');
  ok(cli('analyze', '--root', repo));

  const history = JSON.parse(fs.readFileSync(path.join(repo, '.cascade', 'history', 'index.json'), 'utf8')).entries;
  assert.equal(history.length, 1, 'the second certified run kept the first build');
  assert.equal(history[0].commit, git(repo, 'rev-parse', 'HEAD~1').trim());

  const fromHistory = ok(cli('diff', '--root', repo, '--base-commit', 'HEAD~1', '--json'));
  const h = JSON.parse(fromHistory.stdout);
  assert.match(h.baseNote, /from the pack history/);
  assert.deepEqual(h.repository, { verdict: 'same', by: 'root commit' });
  assert.equal(h.conditions.verdict, 'same', JSON.stringify(h.conditions));
  assert.ok(h.nodes.addedIds.includes('statement:com.example.mapper.ItemMapper.restock'));
  assert.ok(h.nodes.addedIds.includes('column:shop_item.stock'), 'the base read the OLD schema');

  fs.rmSync(path.join(repo, '.cascade', 'history'), { recursive: true, force: true });
  const registryBefore = fs.readFileSync(path.join(work, 'home', 'registry.json'), 'utf8');
  const built = ok(cli('diff', '--root', repo, '--base-commit', 'HEAD~1', '--json'));
  const b = JSON.parse(built.stdout);
  assert.match(b.baseNote, /built now in a temporary worktree/);
  assert.doesNotMatch(b.baseNote, /read as they are today/, 'every input of this project is inside the repository, so every one was read at the base commit');
  assert.deepEqual(b.nodes.addedIds, h.nodes.addedIds, 'a base built now says what the kept one said');
  assert.deepEqual([b.edges.added, b.edges.removed, b.edges.regraded], [h.edges.added, h.edges.removed, h.edges.regraded]);
  assert.equal(b.conditions.verdict, 'same', JSON.stringify(b.conditions));
  assert.equal(git(repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm).length, 1, 'the temporary worktree is gone');
  assert.equal(fs.readFileSync(path.join(work, 'home', 'registry.json'), 'utf8'), registryBefore, 'building the base registered nothing');

  const text = ok(cli('diff', '--root', repo, '--base-commit', 'HEAD~1'));
  assert.match(text.stdout, /^base: commit [0-9a-f]{12}, built now in a temporary worktree/m);
  assert.match(text.stdout, /^conditions: the same/m);

  assert.match(cli('diff', '--root', repo, '--base-commit', 'no-such-rev').stderr, /no commit "no-such-rev"/);

  // A current pack that cannot say how it was analyzed is refused even when the
  // history holds a build that cannot say either: two silences are not agreement.
  write(repo, 'README.md', 'shop\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-q', '-m', 'three');
  ok(cli('analyze', '--root', repo));
  assert.ok(loadHistoryPack(path.join(repo, '.cascade', 'pack'), { commit: git(repo, 'rev-parse', 'HEAD~1').trim() }), 'the history holds a clean build at HEAD~1');
  const strip = (file) => { const p = JSON.parse(fs.readFileSync(file, 'utf8')); delete p.meta.analysis.invocation; fs.writeFileSync(file, JSON.stringify(p)); };
  const kept = JSON.parse(fs.readFileSync(path.join(repo, '.cascade', 'history', 'index.json'), 'utf8')).entries;
  for (const e of kept) strip(path.join(repo, '.cascade', 'history', e.id, 'pack.json'));
  strip(path.join(repo, '.cascade', 'pack', 'pack.json'));
  const refused = cli('diff', '--root', repo, '--base-commit', 'HEAD~1');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /does not record how it was analyzed/);
});

test('a pack of another repository is refused, with the way to compare a project with itself', { timeout: 600000 }, (t) => {
  if (!fs.existsSync(VENV_PY)) { t.skip(`no venv python at ${VENV_PY}`); return; }
  const { work, cli, repo } = setup(t);
  const other = path.join(work, 'other');
  write(other, 'db/schema.sql', SCHEMA_2);
  write(other, 'src/main/resources/mapper/ItemMapper.xml', mapper(STOCK));
  git(other, 'init', '-q', '-b', 'main');
  git(other, 'add', '-A');
  git(other, 'commit', '-q', '-m', 'x');
  for (const [dir, id] of [[repo, 'shop'], [other, 'other']]) {
    assert.equal(cli('init', '--root', dir, '--project', id).status, 0);
    assert.equal(cli('analyze', '--root', dir).status, 0);
  }
  const r = cli('diff', '--root', repo, '--base', path.join(other, '.cascade', 'pack'));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /the two packs are of different repositories \(root commit: "[0-9a-f]{40}" and "[0-9a-f]{40}"\)/);
  assert.match(r.stderr, /cascade diff --base-commit <rev>/);
});

test('a head analyzed with explicit lane flags gets a base analyzed with the same flags, and a head that records none is refused', { timeout: 600000 }, (t) => {
  if (!fs.existsSync(VENV_PY)) { t.skip(`no venv python at ${VENV_PY}`); return; }
  const { cli, repo } = setup(t);
  const ok = (r) => { assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`); return r; };
  ok(cli('init', '--root', repo, '--project', 'shop'));
  write(repo, 'db/schema.sql', SCHEMA_2);
  write(repo, 'src/main/resources/mapper/ItemMapper.xml', mapper(STOCK));
  git(repo, 'add', 'db', 'src');
  git(repo, 'commit', '-q', '-m', 'two');
  // Typed from the directory ABOVE the project, the way a shell in a workspace would.
  // The mapper root is given twice: the selection keeps both, and so must the replay.
  const flags = ['--ddl', path.join('shop', 'db', 'schema.sql'), '--mappers', path.join('shop', 'src', 'main', 'resources', 'mapper'), '--mappers', path.join('shop', 'src', 'main', 'resources', 'mapper'), '--no-java'];
  ok(cli.from(path.dirname(repo), 'analyze', '--root', repo, ...flags));
  const head = JSON.parse(fs.readFileSync(path.join(repo, '.cascade', 'pack', 'pack.json'), 'utf8'));
  assert.deepEqual(head.meta.analysis.invocation.ddl, ['db/schema.sql'], 'a flag typed relative to the shell is recorded relative to the project');
  assert.deepEqual(head.meta.analysis.invocation.mappers, ['src/main/resources/mapper', 'src/main/resources/mapper']);
  assert.equal(head.meta.analysis.invocation.noJava, true);

  const d = JSON.parse(ok(cli('diff', '--root', repo, '--base-commit', 'HEAD~1', '--json')).stdout);
  assert.match(d.baseNote, /built now in a temporary worktree, the way the current pack was analyzed/);
  assert.equal(d.conditions.verdict, 'same', `the base replayed the head's flags: ${JSON.stringify(d.conditions)}`);
  assert.ok(d.nodes.addedIds.includes('column:shop_item.stock'), 'and it read the schema of its own commit');

  delete head.meta.analysis.invocation;
  fs.writeFileSync(path.join(repo, '.cascade', 'pack', 'pack.json'), JSON.stringify(head));
  const refused = cli('diff', '--root', repo, '--base-commit', 'HEAD~1');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /does not record how it was analyzed/);
});
