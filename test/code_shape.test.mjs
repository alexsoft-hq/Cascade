// code_shape.test.mjs — the ratchet on how long and how branchy a function may be.
//
// The rule, in one sentence: a file's worst function may get better and may not
// get worse, and a function nobody has seen before starts small.
//
// It is a ratchet rather than a limit because a limit has to be either useless
// or unusable. `max-lines-per-function: 80` over a repository whose longest
// function is two thousand lines is red on every commit until somebody switches
// it off; `max-lines-per-function: 2100` says nothing at all. The baseline
// (test/fixtures/code-shape.baseline.json) records what each file is TODAY, this
// test fails when a file gets worse, and `node scripts/code-shape.mjs --accept`
// may only write a number DOWN.
//
// The two rules together close the obvious hole. Splitting a 1 700-line function
// into a 1 600-line one plus a new 100-line one lowers no number that matters,
// so a function whose name the baseline does not carry for that file is judged
// against 80 lines and 30 branches on its own.
//
// The measurement lives in scripts/code-shape.mjs and uses the vendored babel
// parser, so this test needs no npm install.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BASELINE_FILE, SHAPE_SCHEMA, NEW_FUNCTION_LINES, NEW_FUNCTION_BRANCHES,
  measure, readBaseline, compare, seal, functionsIn, filesInScope,
} from '../scripts/code-shape.mjs';

const NOW = measure();
const BASELINE = readBaseline();

test('the baseline is sealed, and describes the files that are in scope', () => {
  assert.ok(BASELINE, `no baseline at ${BASELINE_FILE}: seal one with \`node scripts/code-shape.mjs --accept\``);
  assert.equal(BASELINE.schema, SHAPE_SCHEMA);
  const inScope = new Set(filesInScope());
  const sealed = Object.keys(BASELINE.files);
  assert.ok(sealed.length > 40, `only ${sealed.length} file(s) sealed`);
  // A file in the baseline that no longer exists is a baseline nobody re-sealed
  // after a delete: the ratchet would then be guarding a ghost.
  const ghosts = sealed.filter((f) => !inScope.has(f));
  assert.deepEqual(ghosts, [], 'these files are in the baseline and no longer in scope; re-seal it');
});

test('no file\'s longest or branchiest function is worse than the baseline holds it', () => {
  const cmp = compare(NOW, BASELINE);
  assert.deepEqual(
    cmp.regressions, [],
    'a function grew past what the baseline holds. Split it, or — if the growth is the point — '
    + 'change test/fixtures/code-shape.baseline.json BY HAND in the same commit and say why',
  );
});

test(`a function the baseline does not name is at most ${NEW_FUNCTION_LINES} lines and ${NEW_FUNCTION_BRANCHES} branches`, () => {
  const cmp = compare(NOW, BASELINE);
  assert.deepEqual(
    cmp.newTooBig, [],
    'a NEW function is over the limit. The baseline protects the functions that were already there; '
    + 'a new one starts small, so this one wants splitting',
  );
});

test('every file in scope is in the baseline', () => {
  const cmp = compare(NOW, BASELINE);
  assert.deepEqual(
    cmp.unknownFiles, [],
    'these files are in scope and not in the baseline. Run `node scripts/code-shape.mjs --accept` '
    + 'to seal them, in the commit that adds them',
  );
});

// ---------------------------------------------------------------------------
// the measurement itself
//
// A ratchet is only as good as what it counts, so what it counts is pinned here
// on source written in this file rather than on the engine, which moves.
// ---------------------------------------------------------------------------

test('lines are the whole span, branches are every way the code can go', () => {
  const fns = functionsIn(`
function shaped(a, b) {
  if (a) return 1;
  for (const x of b) {
    while (x) break;
  }
  switch (a) {
    case 1: break;
    case 2: break;
    default: break;
  }
  try { return a ? 2 : 3; } catch (e) { return a && b; }
}
`);
  assert.equal(fns.length, 1);
  const f = fns[0];
  assert.equal(f.name, 'shaped');
  assert.equal(f.lines, 12, 'the span is the whole declaration, first line to last');
  // if, for-of, while, two cases (never `default`), ternary, catch, `&&` = 8.
  assert.equal(f.branches, 8, JSON.stringify(f));
});

test('a nested function counts inside its owner AND on its own', () => {
  const fns = functionsIn(`
function outer(xs) {
  return xs.map((x) => (x ? 1 : 0));
}
`);
  const outer = fns.find((f) => f.name === 'outer');
  assert.equal(outer.branches, 1, 'the ternary inside the callback is part of what `outer` does');
  const inner = fns.find((f) => f.name !== 'outer');
  assert.equal(inner.name, 'outer/1', 'an anonymous function is named by its owner, never by its line');
  assert.equal(inner.branches, 1);
});

test('an anonymous function keeps its name when the lines above it move', () => {
  const body = 'function owner() {\n  return [1].map(() => 2);\n}\n';
  const before = functionsIn(body).map((f) => f.name);
  const after = functionsIn(`// a comment somebody added\n\n${body}`).map((f) => f.name);
  assert.deepEqual(after, before, 'a name that moves with the line number would make every edit look like a new function');
});

test('an arrow takes the name of the binding it is assigned to', () => {
  const fns = functionsIn('const cut = (xs) => xs.slice(0, 3);\nconst o = { pick(x) { return x; } };\n');
  assert.deepEqual(fns.map((f) => f.name).sort(), ['cut', 'pick']);
});

// ---------------------------------------------------------------------------
// the ratchet's own direction
// ---------------------------------------------------------------------------

const shape = (maxLines, maxBranches, functions) => ({
  maxLines, maxBranches, longest: functions[0], branchiest: functions[0], functions,
});

test('compare: a file that got worse is a regression, a file that got better is not', () => {
  const base = { schema: SHAPE_SCHEMA, files: { 'src/a.mjs': shape(100, 40, ['big']) } };
  const worse = { files: { 'src/a.mjs': shape(101, 40, ['big']) }, all: [{ file: 'src/a.mjs', name: 'big', line: 1, lines: 101, branches: 40 }] };
  assert.equal(compare(worse, base).regressions.length, 1);
  const better = { files: { 'src/a.mjs': shape(60, 20, ['big']) }, all: [{ file: 'src/a.mjs', name: 'big', line: 1, lines: 60, branches: 20 }] };
  const cmp = compare(better, base);
  assert.deepEqual(cmp.regressions, []);
  assert.equal(cmp.improvements.length, 1);
});

test('compare: a NEW function is judged on its own, even under a generous baseline', () => {
  const base = { schema: SHAPE_SCHEMA, files: { 'src/a.mjs': shape(2000, 800, ['giant']) } };
  const now = {
    files: { 'src/a.mjs': shape(2000, 800, ['giant', 'fresh']) },
    all: [
      { file: 'src/a.mjs', name: 'giant', line: 1, lines: 2000, branches: 800 },
      { file: 'src/a.mjs', name: 'fresh', line: 2001, lines: NEW_FUNCTION_LINES + 1, branches: 1 },
    ],
  };
  const cmp = compare(now, base);
  assert.deepEqual(cmp.regressions, [], 'the file itself did not get worse');
  assert.equal(cmp.newTooBig.length, 1, 'and the new function is still too big to be added quietly');
  assert.match(cmp.newTooBig[0], /fresh/);
});

test('seal: --accept writes a number down and REFUSES to write one up', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-shape-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const file = path.join(tmp, 'baseline.json');
  const base = { schema: SHAPE_SCHEMA, files: { 'src/a.mjs': shape(100, 40, ['big']) } };

  const down = seal({ files: { 'src/a.mjs': shape(60, 20, ['big']) }, all: [] }, base, file);
  assert.equal(down.written, true);
  assert.deepEqual(down.refused, []);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).files['src/a.mjs'].maxLines, 60);

  const up = seal({ files: { 'src/a.mjs': shape(101, 40, ['big']) }, all: [] }, base, file);
  assert.equal(up.written, false, 'a rise must not be sealable');
  assert.equal(up.refused.length, 1);
  assert.match(up.refused[0], /RISE/);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).files['src/a.mjs'].maxLines, 60, 'the refused seal left the file alone');
});

test('the two giants of the web lane are the shape this round left them', () => {
  // Named here rather than only in the baseline, because they are the point of
  // round RM49: if either grows back, this line says which one and by how much.
  const bridge = NOW.files['src/adapters/web_bridge.mjs'];
  const worker = NOW.files['adapters/web/webfacts.mjs'];
  assert.ok(bridge.maxLines <= BASELINE.files['src/adapters/web_bridge.mjs'].maxLines,
    `web_bridge.mjs longest is ${bridge.maxLines} (${bridge.longest})`);
  assert.ok(worker.maxLines <= BASELINE.files['adapters/web/webfacts.mjs'].maxLines,
    `webfacts.mjs longest is ${worker.maxLines} (${worker.longest})`);
});
