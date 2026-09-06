import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// WHO A PACK SAYS IT IS ABOUT (SPEC §5.1).
//
// `analyze` already works out one project id to address the fact cache with:
// the registry's id, else the manifest's, else --project, else the name of the
// directory being analyzed. `pack.meta.project` used to be a SECOND rule that
// only read --project, so a run without the flag shipped a pack calling itself
// "project" while its shards sat under the real id. Two names for one run is
// how a reader ends up looking at the wrong project's answer.
//
// These tests drive the real CLI, because the defect was in the wiring, not in
// a function. SQL lane only (no Java), so this needs the venv python; when it
// is missing the test SKIPS WITH THE REASON, never silently (SPEC §16.3).

const ENGINE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const CLI = path.join(ENGINE_ROOT, 'bin', 'cascade.mjs');
const VENV_PY = path.join(ENGINE_ROOT, '.venv', 'bin', 'python');

function preflight() {
  if (!fs.existsSync(VENV_PY)) {
    return `no venv python at ${VENV_PY}. Run: python3 -m venv .venv && .venv/bin/pip install -r adapters/sql/requirements.txt (see docs/setup/sql-lane.md)`;
  }
  return null;
}

const MAPPER_DIR = 'src/main/resources/mapper';
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n';
const FILES = {
  'schema.sql': `CREATE TABLE \`shop_item\` (
  \`id\` bigint(20) NOT NULL AUTO_INCREMENT,
  \`name\` varchar(64) DEFAULT NULL COMMENT 'item name',
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
`,
  [`${MAPPER_DIR}/ItemMapper.xml`]: `${XML_HEAD}<mapper namespace="com.example.mapper.ItemMapper">
  <select id="selectById" resultType="java.util.Map">
    select id, name from shop_item where id = #{id}
  </select>
</mapper>
`,
};

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'id', GIT_AUTHOR_EMAIL: 'id@example.com',
  GIT_COMMITTER_NAME: 'id', GIT_COMMITTER_EMAIL: 'id@example.com',
};
const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], {
  stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...GIT_ENV },
}).toString('utf8');

function makeRepo(dir) {
  for (const [rel, body] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body, 'utf8');
  }
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'base']);
  return dir;
}

/** The CLI with its home and cache inside the temp dir, never the real ones. */
function cliIn(home) {
  return (args) => spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8', maxBuffer: 1 << 28,
    env: { ...process.env, XDG_CACHE_HOME: path.join(home, 'cache'), CASCADE_HOME: path.join(home, 'home') },
  });
}

const analyzeArgs = (repo, extra = []) => ['analyze', '--root', repo,
  '--ddl', path.join(repo, 'schema.sql'),
  '--mappers', path.join(repo, MAPPER_DIR),
  '--no-java', ...extra];

const packOf = (repo) => JSON.parse(fs.readFileSync(path.join(repo, '.cascade', 'pack', 'pack.json'), 'utf8'));

test('analyze with no --project takes the id from the manifest, not the literal "project"', { timeout: 600000 }, (t) => {
  const why = preflight();
  if (why) { t.skip(why); return; }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-identity-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const repo = makeRepo(path.join(work, 'checkout'));
  const cli = cliIn(work);

  const init = cli(['init', '--root', repo, '--project', 'foo']);
  assert.equal(init.status, 0, init.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(repo, '.cascade', 'manifest.json'), 'utf8')).project, 'foo');

  const run = cli(analyzeArgs(repo));
  assert.equal(run.status, 0, run.stderr);
  const pack = packOf(repo);
  assert.equal(pack.meta.project, 'foo',
    'the manifest already named this project; the pack must not call itself something else');

  // The same id addresses the fact cache, so the pack and its shards agree.
  assert.ok(fs.existsSync(path.join(work, 'cache', 'cascade', 'foo')),
    'the shards belong to the project the pack names');
});

test('analyze with no manifest and no --project falls back to the root directory name, slugified', { timeout: 600000 }, (t) => {
  const why = preflight();
  if (why) { t.skip(why); return; }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-identity-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  // A directory name that is not already a legal id, so the slug rule shows.
  const repo = makeRepo(path.join(work, 'Shop Front'));
  const cli = cliIn(work);

  const run = cli(analyzeArgs(repo));
  assert.equal(run.status, 0, run.stderr);
  assert.equal(packOf(repo).meta.project, 'shop-front');
});

test('an explicit --project is used when nothing else names the project', { timeout: 600000 }, (t) => {
  const why = preflight();
  if (why) { t.skip(why); return; }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-identity-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const repo = makeRepo(path.join(work, 'checkout'));
  const cli = cliIn(work);

  const run = cli(analyzeArgs(repo, ['--project', 'bar']));
  assert.equal(run.status, 0, run.stderr);
  assert.equal(packOf(repo).meta.project, 'bar');
});

test('the project name is metadata: naming the same run differently does not move the digest', { timeout: 600000 }, (t) => {
  const why = preflight();
  if (why) { t.skip(why); return; }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-identity-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const cli = cliIn(work);

  const named = makeRepo(path.join(work, 'one'));
  assert.equal(cli(analyzeArgs(named, ['--project', 'bar'])).status, 0);
  const unnamed = makeRepo(path.join(work, 'two'));
  assert.equal(cli(analyzeArgs(unnamed)).status, 0);

  assert.equal(packOf(named).meta.project, 'bar');
  assert.equal(packOf(unnamed).meta.project, 'two');
  assert.equal(packOf(named).digest, packOf(unnamed).digest,
    'meta sits outside the digest, so the same sources must digest the same under either name');
});
