// remedies.test.mjs — the one thing to do about a gap, said by the engine (RM67-U2d).
//
// Ghostfolio showed 0% on every card because 117 of its 118 routes were
// guesses, and the key that makes them sure (tsBackend.globalPrefixExclude) was
// named in one sentence on another page. So the overview now carries, beside
// every gap, diagnostic and axis that is not whole, the one thing to do when the
// engine knows it: a profile key with a short example, a flag, a command or a
// mode. These tests hold that data to the engine it talks about: every key is
// one the profile validator takes, with an example it accepts; every flag is
// one `cascade analyze` has; every command is a real subcommand; a diagnostic's
// remedy is the key its own sentence already names; and a kind whose fix the
// engine does not know says so with null, never a guess.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Graph } from '../src/core/graph.mjs';
import { callTool } from '../src/mcp/catalog.mjs';
import { buildOverview } from '../src/core/overview.mjs';
import { normalizeProfile, validateProfile, readKeyPath } from '../src/core/profile.mjs';
import { COMMANDS, commandUsage } from '../src/cli/usage.mjs';
import {
  AXIS_REMEDIES, DIAGNOSTIC_REMEDIES, GAP_REMEDIES, REMEDY_EXAMPLES,
  axisRemedies, diagnosticRemedy, gapRemedy, routeRemedy,
} from '../src/core/remedies.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

/** Every engine source file, read once: the kinds a table names must be kinds the engine emits. */
function engineSources() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.mjs')) out.push({ file: path.relative(ROOT, p), text: fs.readFileSync(p, 'utf8') });
    }
  };
  walk(path.join(ROOT, 'src'));
  return out;
}
const SOURCES = engineSources();

/** Set a value at a dotted key path of a fresh object. */
function atPath(keyPath, value) {
  const out = {};
  const parts = keyPath.split('.');
  let o = out;
  parts.slice(0, -1).forEach((p) => { o[p] = {}; o = o[p]; });
  o[parts.at(-1)] = value;
  return out;
}

// ---------------------------------------------------------------------------
// the tables, held to the engine they talk about
// ---------------------------------------------------------------------------

test('every key a remedy declares is a profile key, and its example is a value the profile validator accepts', () => {
  const declared = [...Object.values(GAP_REMEDIES), ...Object.values(DIAGNOSTIC_REMEDIES), ...Object.values(AXIS_REMEDIES)]
    .filter((r) => r.action === 'declare' && typeof r.key === 'string').map((r) => r.key);
  assert.ok(declared.includes('tsBackend.globalPrefixExclude'));
  for (const key of new Set([...declared, ...Object.keys(REMEDY_EXAMPLES)])) {
    assert.equal(typeof REMEDY_EXAMPLES[key], 'string', `${key} has no example to show beside it`);
    const dflt = readKeyPath(normalizeProfile({}), key);
    assert.notEqual(dflt, undefined, `${key} is not a key of the profile`);
    const value = JSON.parse(REMEDY_EXAMPLES[key]);
    assert.doesNotThrow(() => validateProfile(normalizeProfile(atPath(key, value))), `the example for ${key} is not a value the profile takes`);
    assert.ok(REMEDY_EXAMPLES[key].length <= 70, `${key}: an example is short, one line beside a gap`);
  }
});

test('every flag a remedy names is one `cascade analyze` has, and every command is a real subcommand with that flag', () => {
  const analyze = commandUsage('analyze');
  const all = [...Object.values(GAP_REMEDIES), ...Object.values(DIAGNOSTIC_REMEDIES), ...Object.values(AXIS_REMEDIES)];
  for (const r of all.filter((x) => x.action === 'flag')) {
    assert.ok(analyze.includes(`${r.flag} `), `cascade analyze has no ${r.flag}`);
    assert.ok(r.example.startsWith(`${r.flag} `), `${r.flag}: the example shows the flag with its argument`);
  }
  for (const r of all.filter((x) => x.action === 'run')) {
    const [bin, sub, ...rest] = r.command.split(' ');
    assert.equal(bin, 'cascade');
    assert.ok(COMMANDS.includes(sub), `${sub} is not a cascade command`);
    for (const f of rest.filter((w) => w.startsWith('--'))) assert.ok(commandUsage(sub).includes(f), `cascade ${sub} has no ${f}`);
  }
});

test('every kind a table names is one the engine emits, so a remedy cannot outlive its gap', () => {
  const overview = SOURCES.find((s) => s.file === 'src/core/overview.mjs').text;
  for (const kind of Object.keys(GAP_REMEDIES)) assert.ok(overview.includes(`kind: '${kind}'`), `no gap of kind ${kind} is emitted`);
  for (const kind of Object.keys(DIAGNOSTIC_REMEDIES)) {
    assert.ok(SOURCES.some((s) => s.text.includes(`kind: '${kind}'`)), `no diagnostic of kind ${kind} is emitted`);
  }
  const axes = new Set(['catalog', 'statements', 'column', 'code', 'web', 'screen', 'jpa', 'mybatisPlus']);
  for (const k of Object.keys(AXIS_REMEDIES)) {
    const [axis, status] = k.split(':');
    assert.ok(axes.has(axis) && ['degraded', 'not-shipped'].includes(status), k);
  }
});

test('a diagnostic\'s remedy is the key or flag its own sentence already names', () => {
  // The line that emits the kind, and the lines around it, must name what the
  // table says to do: a table that drifted from the sentence would send a reader
  // somewhere the diagnostic does not.
  for (const [kind, r] of Object.entries(DIAGNOSTIC_REMEDIES)) {
    if (r.key === null) continue;  // the diagnostic's own `key` says it
    const want = r.action === 'declare' ? r.key : r.flag;
    const near = SOURCES.flatMap((s) => {
      const lines = s.text.split('\n');
      return lines.flatMap((l, i) => (l.includes(`kind: '${kind}'`) ? [lines.slice(i, i + 3).join('\n')] : []));
    });
    assert.ok(near.length > 0, kind);
    assert.ok(near.some((x) => x.includes(want)), `${kind}: its sentence does not name ${want}`);
  }
});

// ---------------------------------------------------------------------------
// one remedy, resolved
// ---------------------------------------------------------------------------

test('a gap\'s remedy: a command, a flag, a wider mode, or null where the engine knows no single fix', () => {
  assert.deepEqual(gapRemedy('no-catalog', { mode: 'conservative' }), { action: 'run', command: 'cascade catalog fetch --candidate 1' });
  assert.deepEqual(gapRemedy('not-shipped', { mode: 'conservative' }), { action: 'flag', flag: '--java-src', example: '--java-src <dir>' });
  // A mode floor: the next wider mode, and nothing past the widest.
  assert.deepEqual(gapRemedy('mode-floor', { mode: 'strict' }), { action: 'mode', mode: 'conservative' });
  assert.deepEqual(gapRemedy('mode-floor', { mode: 'conservative' }), { action: 'mode', mode: 'heuristic' });
  assert.equal(gapRemedy('mode-floor', { mode: 'heuristic' }), null);
  // Routes a generator's naming paired are HEURISTIC: the mode that walks them, or none when this one does.
  assert.deepEqual(gapRemedy('contract-links', { mode: 'strict' }), { action: 'mode', mode: 'heuristic' });
  assert.equal(gapRemedy('contract-links', { mode: 'heuristic' }), null);
  // The calls it could not follow: a module nobody passed is the part a flag fixes, and only that part.
  const outside = { laneStats: { unresolvedCalls: 88, unresolvedCallsByReason: { 'project-type-outside-roots': 88 } }, mode: 'conservative' };
  assert.deepEqual(gapRemedy('unresolved-calls', outside), { action: 'flag', flag: '--java-src', example: '--java-src <module>/src/main/java' });
  assert.equal(gapRemedy('unresolved-calls', { laneStats: { ts: { calls: { unresolved: 1874 } } }, mode: 'conservative' }), null,
    'a TypeScript call the lane could not place has no flag that places it');
  assert.equal(gapRemedy('external-symbols', { mode: 'conservative' }), null);
  assert.equal(gapRemedy('a-gap-from-tomorrow', { mode: 'conservative' }), null, 'an unknown kind is null, not a guess');
});

test('a diagnostic\'s remedy: its key with a short example; the diagnostic\'s own key where the table says so', () => {
  const r = diagnosticRemedy({ kind: 'TS_PREFIX_EXCLUDE_UNREAD', key: 'tsBackend', reason: '…' });
  assert.equal(r.action, 'declare');
  assert.equal(r.key, 'tsBackend.globalPrefixExclude');
  assert.equal(r.example, REMEDY_EXAMPLES['tsBackend.globalPrefixExclude']);
  assert.deepEqual(diagnosticRemedy({ kind: 'SETTING_IN_CODE', key: 'pathPrefixes', reason: '…' }),
    { action: 'declare', key: 'pathPrefixes', example: REMEDY_EXAMPLES.pathPrefixes });
  assert.equal(diagnosticRemedy({ kind: 'SETTING_IN_CODE', key: 'aKeyWithNoExample', reason: '…' }), null,
    'a key the engine has no example for is not handed out bare');
  assert.equal(diagnosticRemedy({ kind: 'TS_MODULE_IMPORT_UNREAD', key: 'tsBackend', reason: '…' }), null);
  assert.equal(diagnosticRemedy({ kind: 'MISSING_INPUT', key: 'frameworkPacks', reason: '…' }), null,
    'one kind with many causes has no one fix');
});

test('an axis that is not whole: its own fix, or the fix of the axis it follows from', () => {
  const r = axisRemedies({
    catalog: { status: 'not-shipped', reason: 'no catalog' },
    column: { status: 'degraded', reason: 'the lanes ran without a DB catalog' },
    code: { status: 'shipped', reason: null },
    mybatisPlus: { status: 'degraded', reason: 'no mybatisPlus.namingStrategy' },
    screen: { status: 'not-shipped', reason: 'the screen axis is off' },
  });
  assert.deepEqual(r.catalog, { action: 'run', command: 'cascade catalog fetch --candidate 1' });
  assert.deepEqual(r.column, r.catalog, 'columns read in part because no schema was read: the schema is the fix');
  assert.deepEqual(r.mybatisPlus, { action: 'declare', key: 'mybatisPlus.namingStrategy', example: REMEDY_EXAMPLES['mybatisPlus.namingStrategy'] });
  assert.equal(r.screen, null, 'a screen axis switched off for a reason the engine cannot name has no one fix');
  assert.equal(Object.hasOwn(r, 'code'), false, 'a whole axis needs no remedy');
  assert.deepEqual(axisRemedies(null), {});
});

test('the routes whose own address is a guess: the fix a diagnostic names, else the mode that walks them, else null', () => {
  const diag = [{ kind: 'TS_PREFIX_EXCLUDE_UNREAD', key: 'tsBackend', reason: '…' }];
  assert.deepEqual(routeRemedy({ EXACT: 1, HEURISTIC: 117 }, 'conservative', diag),
    { action: 'declare', key: 'tsBackend.globalPrefixExclude', example: REMEDY_EXAMPLES['tsBackend.globalPrefixExclude'] });
  assert.deepEqual(routeRemedy({ EXACT: 1, HEURISTIC: 3 }, 'conservative', []), { action: 'mode', mode: 'heuristic' });
  assert.equal(routeRemedy({ EXACT: 1, HEURISTIC: 3 }, 'heuristic', []), null, 'this mode already walks them');
  assert.equal(routeRemedy({ EXACT: 4, SOUND_SET: 2 }, 'conservative', diag), null, 'no route is a guess');
  assert.equal(routeRemedy({ UNRESOLVED: 2 }, 'conservative', []), null, 'no mode walks an unresolved link');
});

// ---------------------------------------------------------------------------
// on the overview answer
// ---------------------------------------------------------------------------

/** One guessed route and one sure one, onto a handler that reaches a table (disclosure.test.mjs's shape). */
function graph() {
  const g = new Graph();
  const ctl = 'symbol:src/a.controller.ts#A.get';
  g.addNode({ id: 'endpoint:GET /api/a', path: '/api/a', httpMethod: 'GET', handler: ctl, apiGroup: 'a' });
  g.addNode({ id: 'endpoint:GET /api/b', path: '/api/b', httpMethod: 'GET', handler: ctl, apiGroup: 'b' });
  g.addEdge({ from: 'endpoint:GET /api/a', to: ctl, type: 'HANDLES', grade: 'HEURISTIC' });
  g.addEdge({ from: 'endpoint:GET /api/b', to: ctl, type: 'HANDLES', grade: 'EXACT' });
  g.addNode({ id: ctl, file: 'src/a.controller.ts', lane: 'ts' });
  g.addNode({ id: 'statement:s1', statementType: 'select' });
  g.addEdge({ from: ctl, to: 'statement:s1', type: 'IMPLEMENTS_STMT', grade: 'EXACT' });
  g.addEdge({ from: 'statement:s1', to: 'table:A', type: 'EXECUTES', grade: 'EXACT', evidence: { access: 'read' } });
  return g;
}
const META = {
  project: 'p', digest: 'd', lanes: ['ts'],
  laneStats: { ts: { calls: { resolved: 3, external: 1, unresolved: 7 } } },
  axes: { catalog: { status: 'not-shipped', reason: 'no catalog' }, code: { status: 'shipped', reason: null } },
  diagnostics: [
    { kind: 'TS_PREFIX_EXCLUDE_UNREAD', severity: 'warn', key: 'tsBackend', reason: 'Declare the list as tsBackend.globalPrefixExclude in the profile to read it' },
    { kind: 'TS_MODULE_IMPORT_UNREAD', severity: 'warn', key: 'tsBackend', reason: 'its imports spread a list' },
  ],
};
const ask = (args = {}, profile = {}) => callTool('overview', args, {
  graph: graph(), pack: META, profile, trust: { trustLevel: 'UNCERTIFIED' },
  basis: { project: 'p', buildDigest: 'd', builtAt: 'x', freshness: { verdict: 'unknown' } },
});

test('the overview answer carries a remedy on every gap and diagnostic, one per axis not whole, and one for the guessed routes', () => {
  const a = ask().answer;
  assert.ok(a.gaps.length > 3);
  for (const g of a.gaps) assert.ok(Object.hasOwn(g, 'remedy'), `${g.kind} carries no remedy field (null says "none known")`);
  assert.deepEqual(a.gaps.find((g) => g.kind === 'no-catalog').remedy, { action: 'run', command: 'cascade catalog fetch --candidate 1' });
  assert.equal(a.gaps.find((g) => g.kind === 'unresolved-calls').remedy, null);
  assert.deepEqual(a.gaps.find((g) => g.kind === 'mode-floor').remedy, { action: 'mode', mode: 'heuristic' });
  assert.deepEqual(a.diagnostics.map((d) => [d.kind, d.remedy && d.remedy.key]),
    [['TS_PREFIX_EXCLUDE_UNREAD', 'tsBackend.globalPrefixExclude'], ['TS_MODULE_IMPORT_UNREAD', null]]);
  assert.deepEqual(Object.keys(a.axisRemedies), ['catalog'], 'only the axis that is not whole');
  assert.equal(a.routeRemedy.key, 'tsBackend.globalPrefixExclude', 'the routes are guesses for the reason the diagnostic names');
  // The core census alone, with no diagnostics to read, still carries the gap remedies.
  const core = buildOverview(graph(), { mode: 'heuristic' });
  assert.equal(core.gaps.find((g) => g.kind === 'mode-floor').remedy, null, 'nothing is wider than heuristic');
});

test('the overview says which rule its API group count follows: the path, or the modules the profile declares', () => {
  assert.deepEqual(ask().answer.groupRule, { kind: 'path' });
  assert.equal(ask().answer.reach.groups, 2);
  const declared = ask({}, { moduleAttribution: { packageDepth: 2 } }).answer;
  assert.deepEqual(declared.groupRule, { kind: 'declared', packageDepth: 2 });
  assert.equal(Object.hasOwn(declared.reach, 'groupRule'), false, 'the reach block itself keeps its shape');
});
