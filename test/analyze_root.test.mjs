import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// WHICH TREE `cascade analyze` READS (RM25).
//
// The rule under test is one sentence: `--root` wins, and with no --root a run
// that resolved to a REGISTERED project analyzes that project's own source, not
// whatever directory the shell happened to be in. Before this, `analyze
// --project mall` run from anywhere else analyzed the current directory and
// wrote the result into mall's pack: a pack named after one project describing
// another, with nothing on screen to say so.
//
// Everything here drives the REAL CLI end to end and then reads the pack it
// wrote, because the failure was in how the flags met each other, and a unit
// test of either half would have passed.

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ENGINE_ROOT, 'bin', 'cascade.mjs');

function tmpDir(t, prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const CONTROLLER = `package com.example.web;
@RestController
public class ThingController { @GetMapping("/thing") public String t() { return "t"; } }
`;
const DDL = 'CREATE TABLE `thing` (`id` bigint NOT NULL, `name` varchar(40)) ENGINE=InnoDB;\n';

/**
 * A git repo with one controller and one table, so a lane actually runs.
 * `extraJava` adds plain classes beside it, which is what lets a test tell two
 * trees apart by the java file count `estimate` prints.
 */
function repo(dir, marker, extraJava = 0) {
  fs.mkdirSync(path.join(dir, 'src/main/java/com/example/web'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'db'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'pom.xml'), '<project/>', 'utf8');
  fs.writeFileSync(path.join(dir, 'src/main/java/com/example/web/ThingController.java'),
    CONTROLLER.replace('ThingController', `${marker}Controller`).replace('/thing', `/${marker}`), 'utf8');
  for (let i = 0; i < extraJava; i += 1) {
    fs.writeFileSync(path.join(dir, `src/main/java/com/example/web/Plain${i}.java`),
      `package com.example.web;\npublic class Plain${i} { }\n`, 'utf8');
  }
  fs.writeFileSync(path.join(dir, 'db/schema.sql'), DDL.replace('thing', `${marker}_row`), 'utf8');
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.email=dev@example.com', '-c', 'user.name=dev', 'commit', '-qm', 'init');
  return dir;
}

function run(args, env, cwd) {
  const out = execFileSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, ...env },
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { stdout: out.toString('utf8'), stderr: '' };
}

/** The banner line the analyze run prints before it reads anything. */
function bannerOf(stderrText) {
  const line = stderrText.split('\n').find((l) => l.startsWith('analyzing '));
  assert.ok(line, `no "analyzing …" banner in:\n${stderrText}`);
  const m = /^analyzing (.+) \((.+)\)$/.exec(line.trim());
  assert.ok(m, `the banner is not "analyzing <root> (<why>)": ${line}`);
  return { root: m[1], from: m[2] };
}

/**
 * Analyze, capturing stderr even on success. execFileSync only hands back
 * stderr on a throw, so it is redirected to a file and read from there.
 */
function analyze(args, env, cwd, t) {
  const log = path.join(tmpDir(t, 'cascade-analyze-log-'), 'stderr.txt');
  const fd = fs.openSync(log, 'w');
  let code = 0;
  try {
    execFileSync(process.execPath, [CLI, 'analyze', ...args], {
      env: { ...process.env, ...env }, cwd, stdio: ['ignore', 'ignore', fd], maxBuffer: 1 << 28,
    });
  } catch (e) {
    code = e.status ?? 1;
  } finally {
    fs.closeSync(fd);
  }
  return { code, stderr: fs.readFileSync(log, 'utf8') };
}

test('analyze --project <id> from an unrelated cwd analyzes the REGISTERED project, not the cwd', (t) => {
  const base = tmpDir(t, 'cascade-aroot-');
  const home = path.join(base, 'home');
  const mine = repo(path.join(base, 'mine'), 'mine');
  const elsewhere = repo(path.join(base, 'elsewhere'), 'elsewhere');

  run(['init', '--root', mine, '--project', 'mine'], { CASCADE_HOME: home });
  // …and a second, unrelated tree the run will be started FROM.
  run(['init', '--root', elsewhere, '--project', 'elsewhere'], { CASCADE_HOME: home });

  const res = analyze(['--project', 'mine'], { CASCADE_HOME: home }, elsewhere, t);
  assert.equal(res.code, 0, res.stderr);
  const banner = bannerOf(res.stderr);
  assert.equal(banner.root, fs.realpathSync(mine), 'the banner names the registered project\'s own root');
  assert.equal(banner.from, "the registered project's manifest");

  // And the pack it wrote says the same thing, so nothing downstream can
  // disagree with the banner.
  const pack = JSON.parse(fs.readFileSync(path.join(mine, '.cascade', 'pack', 'pack.json'), 'utf8'));
  assert.equal(pack.meta.project, 'mine');
  assert.equal(fs.realpathSync(pack.meta.base.repoPath), fs.realpathSync(mine));
  // The tables are the registered tree's, not the one we ran from.
  const names = pack.nodes.filter((n) => n.kind === 'table').map((n) => n.id);
  assert.ok(names.some((n) => n.includes('mine_row')), `expected mine_row among ${names.join(', ')}`);
  assert.ok(!names.some((n) => n.includes('elsewhere_row')), 'the cwd\'s schema must not be in this pack');
});

test('--root still wins over the registry, and says so', (t) => {
  const base = tmpDir(t, 'cascade-aroot-flag-');
  const home = path.join(base, 'home');
  const mine = repo(path.join(base, 'mine'), 'mine');
  const other = repo(path.join(base, 'other'), 'other');
  run(['init', '--root', mine, '--project', 'mine'], { CASCADE_HOME: home });

  const res = analyze(['--project', 'mine', '--root', other], { CASCADE_HOME: home }, base, t);
  assert.equal(res.code, 0, res.stderr);
  const banner = bannerOf(res.stderr);
  assert.equal(banner.root, fs.realpathSync(other));
  assert.equal(banner.from, '--root');

  const pack = JSON.parse(fs.readFileSync(path.join(mine, '.cascade', 'pack', 'pack.json'), 'utf8'));
  assert.equal(fs.realpathSync(pack.meta.base.repoPath), fs.realpathSync(other),
    'the operator named the tree; the registry only said where the pack goes');
});

test('a registered project with NO manifest falls back to the directory its .cascade sits in', (t) => {
  const base = tmpDir(t, 'cascade-aroot-nomanifest-');
  const home = path.join(base, 'home');
  const mine = repo(path.join(base, 'mine'), 'mine');
  const elsewhere = repo(path.join(base, 'elsewhere'), 'elsewhere');
  run(['init', '--root', mine, '--project', 'mine'], { CASCADE_HOME: home });
  run(['init', '--root', elsewhere, '--project', 'elsewhere'], { CASCADE_HOME: home });

  // The registry entry stays; the manifest beside it is gone.
  fs.rmSync(path.join(mine, '.cascade', 'manifest.json'));

  const res = analyze(['--project', 'mine'], { CASCADE_HOME: home }, elsewhere, t);
  assert.equal(res.code, 0, res.stderr);
  const banner = bannerOf(res.stderr);
  assert.equal(banner.root, fs.realpathSync(mine));
  assert.equal(banner.from, 'the registered project, which has no manifest');
});

test('with nothing to resolve, the current directory is still the answer', (t) => {
  const base = tmpDir(t, 'cascade-aroot-cwd-');
  const home = path.join(base, 'home');
  const mine = repo(path.join(base, 'mine'), 'mine');
  run(['init', '--root', mine, '--project', 'mine'], { CASCADE_HOME: home });

  const res = analyze([], { CASCADE_HOME: home }, mine, t);
  assert.equal(res.code, 0, res.stderr);
  const banner = bannerOf(res.stderr);
  assert.equal(banner.root, fs.realpathSync(mine));
  assert.equal(banner.from, 'the current directory');
});

test('the banner is printed before any lane runs, so a run against the wrong tree is visible at once', (t) => {
  const base = tmpDir(t, 'cascade-aroot-order-');
  const home = path.join(base, 'home');
  const mine = repo(path.join(base, 'mine'), 'mine');
  run(['init', '--root', mine, '--project', 'mine'], { CASCADE_HOME: home });

  const res = analyze(['--project', 'mine'], { CASCADE_HOME: home }, base, t);
  assert.equal(res.code, 0, res.stderr);
  const lines = res.stderr.split('\n');
  const banner = lines.findIndex((l) => l.startsWith('analyzing '));
  const lanes = lines.findIndex((l) => l.startsWith('lanes ['));
  assert.ok(banner >= 0 && lanes > banner, `the banner must come before the lane line:\n${res.stderr}`);
});

// ---------------------------------------------------------------------------
// `cascade estimate` reads the same tree, by the same rule.
//
// `estimate` prints two halves: what a run over THIS TREE would ship, read from
// discovery, and what the pack that already exists measurably answers. It used
// to take the tree from `--root` or cwd while taking the pack from the resolver,
// so `estimate --project mall` from anywhere else described mall's pack and the
// shell's current directory in one report, with nothing on it saying they were
// two different projects. The count that gave it away is the one asserted here.
// ---------------------------------------------------------------------------

/** The estimate banner: "estimate for <root> (<why>)[, project <id>]". */
function estimateBanner(stdout) {
  const line = stdout.split('\n').find((l) => l.startsWith('estimate for '));
  assert.ok(line, `no "estimate for …" banner in:\n${stdout}`);
  const m = /^estimate for (.+?) \(([^)]+)\)(?:, project (.+))?$/.exec(line.trim());
  assert.ok(m, `the banner is not "estimate for <root> (<why>)": ${line}`);
  return { root: m[1], from: m[2], project: m[3] ?? null };
}

/** The java file count out of the estimate's `code` axis line. */
function javaFilesOf(stdout) {
  const line = stdout.split('\n').find((l) => l.trim().startsWith('code '));
  assert.ok(line, `no "code" axis line in:\n${stdout}`);
  const m = /(\d+) main java file\(s\)/.exec(line);
  assert.ok(m, `the code axis line carries no java file count: ${line}`);
  return Number(m[1]);
}

test('estimate --project <id> from an unrelated cwd describes the REGISTERED project, not the cwd', (t) => {
  const base = tmpDir(t, 'cascade-eroot-');
  const home = path.join(base, 'home');
  // Four java files here, one there: the counts cannot be confused.
  const mine = repo(path.join(base, 'mine'), 'mine', 3);
  const elsewhere = repo(path.join(base, 'elsewhere'), 'elsewhere');

  run(['init', '--root', mine, '--project', 'mine'], { CASCADE_HOME: home });
  run(['init', '--root', elsewhere, '--project', 'elsewhere'], { CASCADE_HOME: home });

  const res = run(['estimate', '--project', 'mine'], { CASCADE_HOME: home }, elsewhere);
  const banner = estimateBanner(res.stdout);
  assert.equal(banner.root, fs.realpathSync(mine), 'the banner names the registered project\'s own root');
  assert.equal(banner.from, "the registered project's manifest");
  assert.equal(banner.project, 'mine');
  assert.equal(javaFilesOf(res.stdout), 4,
    'the "before analysis" half must count the registered project\'s java files, not the cwd\'s');

  // The control: running the same command from the OTHER project reports that
  // project's single file, so the assertion above is measuring the root and not
  // a constant.
  const control = run(['estimate', '--project', 'elsewhere'], { CASCADE_HOME: home }, mine);
  assert.equal(estimateBanner(control.stdout).root, fs.realpathSync(elsewhere));
  assert.equal(javaFilesOf(control.stdout), 1);
});

test('estimate: --root still wins over the registry, and the banner says which rule decided', (t) => {
  const base = tmpDir(t, 'cascade-eroot-flag-');
  const home = path.join(base, 'home');
  const mine = repo(path.join(base, 'mine'), 'mine', 3);
  const other = repo(path.join(base, 'other'), 'other');
  run(['init', '--root', mine, '--project', 'mine'], { CASCADE_HOME: home });

  const res = run(['estimate', '--project', 'mine', '--root', other], { CASCADE_HOME: home }, base);
  const banner = estimateBanner(res.stdout);
  assert.equal(banner.root, fs.realpathSync(other));
  assert.equal(banner.from, '--root');
  assert.equal(javaFilesOf(res.stdout), 1, 'the operator named the tree');
});

test('estimate: with nothing to resolve, the current directory is still the answer', (t) => {
  const base = tmpDir(t, 'cascade-eroot-cwd-');
  const home = path.join(base, 'home');
  const mine = repo(path.join(base, 'mine'), 'mine', 3);
  run(['init', '--root', mine, '--project', 'mine'], { CASCADE_HOME: home });

  const res = run(['estimate'], { CASCADE_HOME: home }, mine);
  const banner = estimateBanner(res.stdout);
  assert.equal(banner.root, fs.realpathSync(mine));
  assert.equal(banner.from, 'the current directory');
  assert.equal(javaFilesOf(res.stdout), 4);
});

// Not under test here: `--pack <dir>`, which names a pack rather than a project
// and so implies no `.cascade/` to read a manifest from. It falls through to the
// cwd branch above, which is the same answer it always gave.