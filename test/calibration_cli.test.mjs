import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The calibration layer as a USER meets it: `cascade analyze` judging a run,
// `cascade verify` recomputing the receipt, `cascade golden` proposing and
// scoring, and the small RM4 leftover — `--mode base-only` must not report the
// project's own `.cascade/` as a changed file.
//
// SQL lane only (no Java), so this needs the venv Python and nothing else. When
// it is missing the test SKIPS WITH THE REASON, never silently (SPEC §16.3).

const ENGINE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const CLI = path.join(ENGINE_ROOT, 'bin', 'cascade.mjs');
const VENV_PY = path.join(ENGINE_ROOT, '.venv', 'bin', 'python');

function preflight() {
  if (!fs.existsSync(VENV_PY)) {
    return `no venv python at ${VENV_PY} — run: python3 -m venv .venv && .venv/bin/pip install -r adapters/sql/requirements.txt (see docs/setup/sql-lane.md)`;
  }
  return null;
}

const MAPPER_DIR = 'src/main/resources/mapper';
const MAPPER = `${MAPPER_DIR}/ItemMapper.xml`;
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n';

const FILES = {
  'schema.sql': `CREATE TABLE \`shop_item\` (
  \`id\` bigint(20) NOT NULL AUTO_INCREMENT,
  \`name\` varchar(64) DEFAULT NULL COMMENT 'item name',
  \`price\` int(11) DEFAULT NULL COMMENT 'price',
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
`,
  [MAPPER]: `${XML_HEAD}<mapper namespace="com.example.mapper.ItemMapper">
  <select id="selectById" resultType="java.util.Map">
    select id, name, price from shop_item where id = #{id}
  </select>
  <update id="rename">
    update shop_item set name = #{name} where id = #{id}
  </update>
</mapper>
`,
};

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'calib', GIT_AUTHOR_EMAIL: 'calib@example.com',
  GIT_COMMITTER_NAME: 'calib', GIT_COMMITTER_EMAIL: 'calib@example.com',
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

function cliIn(home) {
  return (args) => spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8', maxBuffer: 1 << 28,
    env: { ...process.env, XDG_CACHE_HOME: path.join(home, 'cache'), CASCADE_HOME: path.join(home, 'home') },
  });
}

const EMPTY_DIR = 'src/main/resources/empty';

function analyzeArgs(repo, extra = [], mapperDir = MAPPER_DIR) {
  return ['analyze', '--root', repo, '--project', 'calib',
    '--ddl', path.join(repo, 'schema.sql'),
    '--mappers', path.join(repo, mapperDir),
    '--no-java', ...extra];
}

test('the calibration gate, the receipt and the base-only diff, end to end', { timeout: 600000 }, (t) => {
  const why = preflight();
  if (why) { t.skip(why); return; }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-calib-cli-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const repo = makeRepo(path.join(work, 'repo'));
  const cli = cliIn(work);
  const dot = path.join(repo, '.cascade');

  // ---- 1. first run: BOOTSTRAP, and the baseline is sealed ---------------
  const first = cli(analyzeArgs(repo));
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stderr, /^gate: NO_SEAL -> BOOTSTRAP/m);
  assert.ok(fs.existsSync(path.join(dot, 'calibration', 'baseline.json')), 'BOOTSTRAP must seal a baseline');
  const gateState = JSON.parse(fs.readFileSync(path.join(dot, 'calibration', 'gate-state.json'), 'utf8'));
  assert.equal(gateState.schema, 'cascade:golden-gate-state:1');
  assert.equal(gateState.mode, 'NO_SEAL');
  assert.equal(gateState.verdict, 'BOOTSTRAP');
  const pack1 = JSON.parse(fs.readFileSync(path.join(dot, 'pack', 'pack.json'), 'utf8'));
  assert.deepEqual(pack1.meta.calibration, { mode: 'NO_SEAL', verdict: 'BOOTSTRAP', baselineSealedAt: null, firstRun: 'bootstrap' });

  // ---- 2. an identical second run: NO_CHANGE, and that is a free determinism check
  const second = cli(analyzeArgs(repo));
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stderr, /^gate: NO_CHANGE -> GREEN - no metric dropped/m);
  const pack2 = JSON.parse(fs.readFileSync(path.join(dot, 'pack', 'pack.json'), 'utf8'));
  assert.equal(pack2.digest, pack1.digest);

  // ---- 3. the receipt verifies -------------------------------------------
  const ok = cli(['verify', '--root', repo]);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /^verified /m);

  // ---- 4. a RED run leaves the certified pack alone (§7.2) ---------------
  // Point the mapper lane at an empty directory: every statement disappears,
  // which is exactly the kind of collapse the gate exists to refuse.
  fs.mkdirSync(path.join(repo, EMPTY_DIR), { recursive: true });
  const red = cli(analyzeArgs(repo, [], EMPTY_DIR));
  assert.equal(red.status, 3, `a rejected run exits 3\n${red.stderr}`);
  assert.match(red.stderr, /^gate: (REPIN|BOTH_MOVED) -> RED/m);
  assert.match(red.stderr, /node:statement dropped 100%/);
  assert.match(red.stderr, /--accept-baseline/);
  const afterRed = JSON.parse(fs.readFileSync(path.join(dot, 'pack', 'pack.json'), 'utf8'));
  assert.equal(afterRed.digest, pack1.digest, 'the certified pack must be byte-identical after a rejected run');
  const rejected = JSON.parse(fs.readFileSync(path.join(dot, 'pack-rejected', 'pack.json'), 'utf8'));
  assert.notEqual(rejected.digest, pack1.digest, 'the rejected pack is kept, separately, for inspection');
  assert.equal(rejected.meta.calibration.verdict, 'RED');

  // …and `verify` now refuses, because the project's latest gate result is RED.
  const stale = cli(['verify', '--root', repo]);
  assert.equal(stale.status, 4);
  const report = JSON.parse(stale.stdout);
  assert.equal(report.verified, false);
  assert.ok(report.disagreements.find((d) => d.check === 'gate-red'));

  // ---- 5. --accept-baseline is the one override, and it is explicit ------
  const accepted = cli(analyzeArgs(repo, ['--accept-baseline'], EMPTY_DIR));
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stderr, /accepted by --accept-baseline/);
  assert.equal(cli(['verify', '--root', repo]).status, 0);

  // Put the project back the way it was, deliberately.
  const restored = cli(analyzeArgs(repo, ['--accept-baseline']));
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dot, 'pack', 'pack.json'), 'utf8')).digest, pack1.digest);

  // ---- 6. tamper: edit the gate state, and `verify` refuses (§14.4) ------
  const gsFile = path.join(dot, 'calibration', 'gate-state.json');
  const gs = JSON.parse(fs.readFileSync(gsFile, 'utf8'));
  gs.findings = [];
  fs.writeFileSync(gsFile, JSON.stringify(gs, null, 2) + '\n');
  const tampered = cli(['verify', '--root', repo]);
  assert.equal(tampered.status, 4);
  const tamperReport = JSON.parse(tampered.stdout);
  assert.ok(tamperReport.disagreements.find((d) => d.check === 'file:calibration/gate-state.json'),
    `expected a gate-state digest mismatch, got ${JSON.stringify(tamperReport.disagreements)}`);
});

test('base-only lists the edited file and NOT the project\'s own .cascade/ state', { timeout: 600000 }, (t) => {
  const why = preflight();
  if (why) { t.skip(why); return; }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-ownstate-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const repo = makeRepo(path.join(work, 'repo'));
  const cli = cliIn(work);

  assert.equal(cli(analyzeArgs(repo)).status, 0);
  // `cascade analyze` has just written manifest.json, profile.json, the pack,
  // the baseline, the gate state and the receipt INTO the tree, so git reports
  // all of them as untracked. None of them is source.
  const untracked = git(repo, ['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean);
  assert.ok(untracked.some((f) => f.startsWith('.cascade/')), 'the fixture must actually have dirty .cascade/ files');

  // A real edit, so the answer is about something.
  fs.writeFileSync(path.join(repo, MAPPER), FILES[MAPPER].replace('set name = #{name}', 'set name = #{name}, price = #{price}'), 'utf8');

  const r = cli(['impact', '--root', repo, '--mode', 'base-only']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /mode base-only/);
  assert.match(r.stdout, /changed files: 1\b/, `base-only must see exactly the one edited file, got:\n${r.stdout}`);
  assert.equal(/\.cascade\//.test(r.stdout), false,
    `the project's own state directory must never be reported as a changed file:\n${r.stdout}`);
});

test('cascade golden: the tool proposes, a human approves, a hash seals, and check scores', { timeout: 600000 }, (t) => {
  const why = preflight();
  if (why) { t.skip(why); return; }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-golden-cli-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const repo = makeRepo(path.join(work, 'repo'));
  const cli = cliIn(work);
  const goldenDir = path.join(repo, '.cascade', 'golden');
  assert.equal(cli(analyzeArgs(repo)).status, 0);

  // ---- propose: candidates only, and it says so ---------------------------
  const proposed = cli(['golden', 'propose', '--root', repo, '--per-relation', '3']);
  assert.equal(proposed.status, 0, proposed.stderr);
  assert.match(proposed.stdout, /these are candidates, not evidence/);
  const lines = fs.readFileSync(path.join(goldenDir, 'proposed.jsonl'), 'utf8').split('\n').filter(Boolean);
  assert.ok(lines.length > 0, proposed.stdout);
  const cases = lines.map((l) => JSON.parse(l));
  for (const c of cases) {
    assert.equal(c.proposed, true);
    assert.equal(c.approvedAt, null);
    assert.ok(c.expect.present.length > 0 && c.expect.absent.length > 0, 'positive AND negative (SPEC §14.1)');
  }
  // This pack has no Java lane, so two of the four relations have no candidates
  // at all — and `propose` says which, instead of quietly shipping half a corpus.
  // This pack has no Java lane, so the two code-axis relations have no
  // candidates at all, and the one statement whose answer covers EVERY column of
  // its table cannot be given a negative — so it is skipped rather than shipped
  // as a positive-only case (SPEC §14.1 wants the pair). `propose` says all of
  // that out loud instead of quietly shipping a thinner corpus.
  assert.match(proposed.stdout, /column->endpoints\s+proposed\s+0 of 3/);
  assert.match(proposed.stdout, /endpoint->tables\s+proposed\s+0 of 3/);
  assert.match(proposed.stdout, /statement->columns\s+proposed\s+1 of 3/);
  assert.match(proposed.stdout, /note: method->statements: only 0 of 3/);

  // ---- approve: never by itself ------------------------------------------
  const refused = cli(['golden', 'approve', '--root', repo]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /never approves its own proposals/);
  assert.equal(fs.existsSync(path.join(goldenDir, 'cases.jsonl')), false, 'a refused approve writes nothing');

  const oneId = cases[0].id;
  const one = cli(['golden', 'approve', '--root', repo, '--ids', oneId]);
  assert.equal(one.status, 0, one.stderr);
  const approved = fs.readFileSync(path.join(goldenDir, 'cases.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(approved.length, 1);
  assert.equal(approved[0].id, oneId);
  assert.ok(approved[0].approvedAt, 'approval stamps a time');
  assert.equal(Object.hasOwn(approved[0], 'proposed'), false);

  assert.equal(fs.readFileSync(path.join(goldenDir, 'proposed.jsonl'), 'utf8').trim(), '',
    'an approved proposal leaves the proposal file');

  // `--all` is the other half of the same door, and it is still a human typing it.
  assert.equal(cli(['golden', 'propose', '--root', repo, '--per-relation', '3']).status, 0);
  const rest = cli(['golden', 'approve', '--root', repo, '--all']);
  assert.equal(rest.status, 0, rest.stderr);
  assert.equal(fs.readFileSync(path.join(goldenDir, 'proposed.jsonl'), 'utf8').trim(), '');

  // ---- seal: a hash chooses, then check still scores them -----------------
  const sealed = cli(['golden', 'seal', '--root', repo]);
  assert.equal(sealed.status, 0, sealed.stderr);
  assert.match(sealed.stdout, /decided by sha256\(id\), never by hand/);

  const checked = cli(['golden', 'check', '--root', repo, '--json']);
  assert.equal(checked.status, 0, checked.stderr);
  const summary = JSON.parse(checked.stdout).summary;
  // Far below 30 cases per relation: INSUFFICIENT_SAMPLE, never a pass.
  assert.equal(summary.status, 'INSUFFICIENT_SAMPLE');
  assert.equal(JSON.parse(checked.stdout).results.every((r) => r.status === 'PASS'), true,
    'every approved case still agrees with the engine that proposed it');

  // ---- and the next analyze folds the golden result into the gate state ---
  const again = cli(analyzeArgs(repo));
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stderr, /^golden: INSUFFICIENT_SAMPLE/m);
  const gs = JSON.parse(fs.readFileSync(path.join(repo, '.cascade', 'calibration', 'gate-state.json'), 'utf8'));
  assert.equal(gs.goldenSummary.status, 'INSUFFICIENT_SAMPLE');
  assert.ok(gs.goldenSummary.scored > 0);
});

// ---------------------------------------------------------------------------
// The scratch directory outlives no exit path (the `.analyze-*` leak)
// ---------------------------------------------------------------------------
//
// `analyze` creates a `.analyze-XXXX` scratch directory in the ENGINE root and
// removed it in a `finally` — but the calibration RED path calls
// `process.exit(3)` from inside that try, and process.exit does not run
// `finally`. Every rejected run therefore leaked one directory into the
// repository (two dozen had accumulated). The fix is an exit handler; this test
// proves it by running a REJECTED analyze and looking at the engine root.
//
// The engine root it looks at is a MIRROR of this repository — bin/cascade.mjs
// copied, everything else symlinked — so the assertion is about THIS run and
// cannot be disturbed by another test file running its own analyze in parallel.

function mirrorEngine(dir) {
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  // A real copy: `import.meta.url` resolves symlinks, so a symlinked CLI would
  // compute the REAL engine root and defeat the isolation.
  fs.copyFileSync(CLI, path.join(dir, 'bin', 'cascade.mjs'));
  for (const name of ['src', 'adapters', 'viewer', 'package.json', '.venv', '.java-build']) {
    const from = path.join(ENGINE_ROOT, name);
    if (fs.existsSync(from)) fs.symlinkSync(from, path.join(dir, name));
  }
  return path.join(dir, 'bin', 'cascade.mjs');
}

const scratchDirs = (root) => fs.readdirSync(root).filter((n) => n.startsWith('.analyze-')).sort();

test('a REJECTED analyze leaves no `.analyze-*` scratch directory behind', { timeout: 600000 }, (t) => {
  const why = preflight();
  if (why) { t.skip(why); return; }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-scratch-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const engineRoot = path.join(work, 'engine');
  const cliPath = mirrorEngine(engineRoot);
  const repo = makeRepo(path.join(work, 'repo'));
  const run = (args) => spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8', maxBuffer: 1 << 28,
    env: { ...process.env, XDG_CACHE_HOME: path.join(work, 'cache'), CASCADE_HOME: path.join(work, 'home') },
  });

  assert.deepEqual(scratchDirs(engineRoot), [], 'the mirrored engine starts clean');

  // 1. a run that SUCCEEDS: the eager removal in the finally does its job.
  const first = run(analyzeArgs(repo));
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(scratchDirs(engineRoot), [], 'a successful run leaves nothing');

  // 2. a run the calibration gate REJECTS: it exits 3 from inside the try, so
  //    only the exit handler can clean up — and it must.
  fs.mkdirSync(path.join(repo, EMPTY_DIR), { recursive: true });
  const red = run(analyzeArgs(repo, [], EMPTY_DIR));
  assert.equal(red.status, 3, `a rejected run exits 3\n${red.stderr}`);
  assert.match(red.stderr, /REJECTED/);
  assert.deepEqual(scratchDirs(engineRoot), [],
    'process.exit(3) skips `finally`; the scratch directory must still be gone');
});
