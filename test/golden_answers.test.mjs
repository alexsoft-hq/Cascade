// golden_answers.test.mjs — the safety net a refactoring round stands on.
//
// WHY. Every other test in this directory asks a question somebody thought to
// ask. A round that MOVES code needs the opposite: a check that notices a change
// nobody thought to ask about. So this file builds three small projects from
// fixtures that are already in this repository, runs the REAL CLI over them,
// starts the REAL MCP server on the packs, records EVERY answer to
// `test/fixtures/golden/`, and fails on a byte that moved.
//
// The three trees, chosen so that every lane and every axis is on at least one:
//   fullstack   a Spring backend (JPA entity, repository, service, four
//               controllers) + `test/fixtures/web-smoke` as its frontend, whose
//               calls really land on the routes that backend serves — so the
//               prefix rules, the route match, the grades, the screens and the
//               RENDERS edges are all exercised at once.
//   angular     the same backend + `test/fixtures/web-angular`: an AngularJS
//               frontend, where a screen's name comes from the registry of
//               component and template names rather than from a router path.
//   templates   the same backend, plus a `@Controller` that returns view names
//               and `test/fixtures/web-templates`' Thymeleaf pages under
//               `src/main/resources/templates` — the server-rendered page.
//
// RE-RECORDING. `CASCADE_RECORD_GOLDEN=1 node --test test/golden_answers.test.mjs`
// rewrites every golden. A golden that changes for a good reason is re-recorded
// ON PURPOSE, in the commit that changed it, and that commit says why. A golden
// that changes in a round that claims to change nothing is the round being wrong.
//
// WHAT IS NORMALISED. The trees are built in a temp directory and `git init`-ed
// on the spot, so the absolute path, the commit sha and the build time are
// different on every run and are not what a golden is about. So is a SIZE IN
// BYTES: a loaded pack's memory proxy counts the absolute paths inside
// facts-index.json, so the same answer measures larger under a long checkout
// directory than under a short one — which is exactly how these goldens first
// went red on CI and stayed green on a laptop. Everything else — the pack digest
// included — is compared byte for byte.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { snapshot, diffDirs, walkFiles, maskVolatile } from '../scripts/answers-snapshot.mjs';
import { findJdk } from '../scripts/ci-java-smoke.mjs';
import { skipWithoutSqlLane } from './helpers/lane_prereqs.mjs';
import { ENGINE_ROOT, FIXTURES, TREES, commit, scrubberFor } from '../scripts/golden-trees.mjs';

const CLI = path.join(ENGINE_ROOT, 'bin', 'cascade.mjs');
const GOLDEN_ROOT = path.join(FIXTURES, 'golden');
const RECORD = process.env.CASCADE_RECORD_GOLDEN === '1';

// ---------------------------------------------------------------------------
// building one tree
// ---------------------------------------------------------------------------

function tmpDir(t, prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Run `cascade analyze` into `out`, failing loudly with the whole log. Returns the log. */
function analyze(args, cwd, home, logFile) {
  const fd = fs.openSync(logFile, 'w');
  try {
    execFileSync(process.execPath, [CLI, 'analyze', ...args], {
      env: { ...process.env, CASCADE_HOME: home }, cwd, stdio: ['ignore', 'ignore', fd], maxBuffer: 1 << 28,
    });
  } catch (e) {
    fs.closeSync(fd);
    throw new Error(`analyze failed (${e.status}):\n${fs.readFileSync(logFile, 'utf8')}`, { cause: e });
  }
  fs.closeSync(fd);
  return fs.readFileSync(logFile, 'utf8');
}

/** Build one tree, analyze it, and record every answer of its pack into `out`. */
async function record(t, name, build, analyzeFlags, out) {
  const base = tmpDir(t, `cascade-golden-${name}-`);
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  build(repo, base);
  commit(repo);
  const pack = path.join(base, 'pack');
  const home = path.join(base, 'home');
  // `init` first, exactly as the documentation says: it writes the manifest and
  // the profile that discovery then reads. Without it a run finds no source root
  // of its own and the pack comes out with only the lane whose flag was given.
  execFileSync(process.execPath, [CLI, 'init', '--root', repo, '--project', name], {
    env: { ...process.env, CASCADE_HOME: home }, cwd: base, stdio: ['ignore', 'ignore', 'pipe'],
  });
  const log = analyze(['--root', repo, '--out', pack, ...analyzeFlags(repo)], base, home, path.join(base, 'analyze.log'));
  // WHILE RE-RECORDING, say what the run actually did. A golden recorded from a
  // tree whose Java lane silently did not run is a net with a hole in it, and
  // the lane lines are where that shows.
  if (RECORD) {
    for (const line of log.split('\n')) {
      if (/^(SQL|Java|JPA|Web|Screen) lane: |^axes: |^wrote /.test(line)) process.stderr.write(`  [${name}] ${line}\n`);
    }
  }
  await snapshot({ out, packs: [{ dir: pack, name }], cap: 200, scrub: scrubberFor(base) });
}

// ---------------------------------------------------------------------------
// the three trees, and the one comparison
// ---------------------------------------------------------------------------

test('every answer the server gives over the three fixture trees is the one it gave before', async (t) => {
  if (skipWithoutSqlLane(t)) return;
  if (!findJdk()) {
    t.skip('no JDK found: JAVA_HOME is unset and no javac on PATH — install a JDK 21 (see docs/setup/java-lane.md); CI runs this check on temurin 21');
    return;
  }
  const out = RECORD ? GOLDEN_ROOT : path.join(tmpDir(t, 'cascade-golden-out-'), 'answers');
  if (RECORD) fs.rmSync(GOLDEN_ROOT, { recursive: true, force: true });
  for (const tree of TREES) {
    await record(t, tree.name, tree.build, tree.flags, out);
  }
  if (RECORD) {
    process.stderr.write(`re-recorded ${walkFiles(GOLDEN_ROOT).length} golden answer(s) under ${GOLDEN_ROOT}\n`);
    return;
  }
  const d = diffDirs(GOLDEN_ROOT, out);
  const report = [
    ...d.onlyInA.map((f) => `  gone: ${f}`),
    ...d.onlyInB.map((f) => `  new:  ${f}`),
    ...d.differ.map((f) => `  differs: ${f}`),
  ].slice(0, 40).join('\n');
  assert.deepEqual(
    { gone: d.onlyInA.length, added: d.onlyInB.length, differ: d.differ.length },
    { gone: 0, added: 0, differ: 0 },
    'an answer moved. Read the diff, and if it is right, re-record with '
    + `CASCADE_RECORD_GOLDEN=1 and SAY WHY in the commit:\n${report}`,
  );
  assert.ok(d.same > 100, `only ${d.same} golden answer(s) compared: the corpus itself has shrunk`);
});

test('the goldens are committed, and cover all three trees', () => {
  const files = walkFiles(GOLDEN_ROOT);
  assert.ok(files.length > 100, `expected the golden corpus to be recorded under ${GOLDEN_ROOT}`);
  for (const tree of TREES) {
    assert.ok(files.some((f) => f.startsWith(`${tree.name}/`)), `no golden answers for the ${tree.name} tree`);
  }
  // Every golden is a recorded answer, not a stray file.
  for (const f of files) {
    assert.match(f, /\.json$/, `${f} is not an answer file`);
  }
});

// ---------------------------------------------------------------------------
// the mask, which is what makes a golden portable
//
// These run with no JDK and no SQL lane, because they are about the recorder
// rather than about the engine. They exist because the first thing the goldens
// caught was not an engine change at all: `projects[].bytes` is pack.json plus
// facts-index.json, facts-index holds the absolute path of the repository the
// pack was built from, and a CI runner's checkout path is about a hundred
// characters longer than a laptop's temp directory. Same answer, a hundred more
// bytes, three red files.
// ---------------------------------------------------------------------------

test('the mask replaces a moment and a size, and leaves the answer alone', () => {
  const masked = maskVolatile({
    id: 'fullstack',
    builtAt: '2026-09-10T00:00:00.000Z',
    lastCertifiedAt: null,
    bytes: 48746,
    digest: '9f01dfcbb8ed',
    cache: { loaded: 1, bytes: 48746, budgetBytes: 536870912, evictions: 0, hits: 38, misses: 1 },
    answer: { rows: 3, unpackedSize: 900, nested: [{ bytes: 1 }] },
  });
  assert.equal(masked.builtAt, '<masked>');
  assert.equal(masked.bytes, '<masked>');
  assert.equal(masked.cache, '<masked>', 'the whole cache block is the server\'s account of this machine');
  assert.equal(masked.answer.unpackedSize, '<masked>');
  assert.equal(masked.answer.nested[0].bytes, '<masked>', 'masked at any depth, inside arrays too');
  // A DIGEST IS CONTENT, NOT A MEASUREMENT. If one ever moves between two
  // machines that is a finding about the engine, and a mask would hide it.
  assert.equal(masked.digest, '9f01dfcbb8ed');
  assert.equal(masked.id, 'fullstack');
  assert.equal(masked.answer.rows, 3);
  // Absent stays absent: "no build time" and "no size" are facts of their own.
  assert.equal(masked.lastCertifiedAt, null);
});

test('two recordings of the same answer under paths of different length are the same bytes', () => {
  // The bug in one line. `bytes` is the only thing that moved, and it moved
  // because the path did.
  const answer = (root) => ({
    projects: [{ id: 'fullstack', dotCascadePath: `${root}/pack`, bytes: 40000 + root.length, digest: 'abc123' }],
    cache: { loaded: 1, bytes: 40000 + root.length, budgetBytes: 536870912, evictions: 0, hits: 3, misses: 1 },
  });
  const shortRoot = '/tmp/a';
  const longRoot = '/build/agent/workspace/ci/a-much-longer-checkout-directory-of-the-kind-a-runner-uses';
  const scrub = (root) => function walk(v) {
    if (typeof v === 'string') return v.split(root).join('<tmp>');
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  const one = JSON.stringify(scrub(shortRoot)(maskVolatile(answer(shortRoot))));
  const two = JSON.stringify(scrub(longRoot)(maskVolatile(answer(longRoot))));
  assert.equal(one, two);
});
