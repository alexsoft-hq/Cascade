// cli_modules.test.mjs — the CLI, module by module, and the layering it was
// split under.
//
// `bin/cascade.mjs` was four thousand lines: fourteen commands as one chain of
// `if (cmd === …)`, fifty-two imports, and every shared helper mixed in among
// them. This round made each command a module and each helper a module, which
// is only worth anything if the pieces can be used one at a time — so every one
// of them is imported DIRECTLY here and asked a question of its own, beyond the
// end-to-end runs that already cover the whole.
//
// The layering is checked too, in both directions. `src/cli/` is the layer that
// knows both sides — it is where the lane bridges are handed to the core — and
// that is exactly why nothing else may depend on it: a CLI helper imported from
// `src/core/` would make the core need a command line.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HELP_FLAGS, makeArgs, wantsHelp } from '../src/cli/args.mjs';
import { COMMANDS, USAGE, USAGE_FOOTER, USAGE_HEADER, commandUsage, usageText } from '../src/cli/usage.mjs';
import { CLI_PATH, DEFAULT_PASSWORD_ENV, ENGINE_ROOT, listMapperXml, manifestAt, parseJsonl, projectIdFrom, realPath, splitZ } from '../src/cli/env.mjs';
import { hashOrNull, relToState, runningEnginePrint, safeHash, sha256File, stateDirOf } from '../src/cli/state.mjs';
import { listOfFive } from '../src/cli/output.mjs';
import { analyzeRoot, expandDdlPatterns, globFiles, webPackagesRead } from '../src/cli/lanes_run.mjs';
import { memoryBudgetBytes, packMeta, runtimeEvidenceBasis, servedEntries } from '../src/cli/serve.mjs';
import { refuse } from '../src/cli/overlay_provider.mjs';
import { makeContext } from '../src/cli/context.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/** Arguments with `die` captured instead of exiting, so a refusal is testable. */
function args(argv) {
  const said = [];
  return {
    said,
    args: makeArgs(argv, { write: (s) => said.push(s), exit: () => { throw new Error(`exit:${said.join('')}`); } }),
  };
}

// ---------------------------------------------------------------------------
// args.mjs — pure over an array
// ---------------------------------------------------------------------------

test('args: --name takes the NEXT word, repeats collect, a bare --name is a switch', () => {
  const { args: a } = args(['analyze', '--root', '/tmp/x', '--ddl', 'a.sql', '--ddl', 'b.sql', '--cold']);
  assert.equal(a.cmd, 'analyze');
  assert.equal(a.opt('root'), '/tmp/x');
  assert.deepEqual(a.optAll('ddl'), ['a.sql', 'b.sql']);
  assert.equal(a.flag('cold'), true);
  assert.equal(a.flag('incremental'), false);
  assert.equal(a.opt('nothing', 'fallback'), 'fallback');
});

test('args: a --name at the very end has no value, so the default stands', () => {
  const { args: a } = args(['analyze', '--root']);
  assert.equal(a.opt('root', 'default'), 'default');
  assert.deepEqual(a.optAll('root'), []);
});

test('args: die says one sentence on stderr and exits 2', () => {
  const { said, args: a } = args(['analyze']);
  assert.throws(() => a.die('no'), /exit:no/);
  assert.deepEqual(said, ['no\n']);
});

test('args: --help and -h are the two spellings, anywhere on the line', () => {
  assert.deepEqual([...HELP_FLAGS], ['--help', '-h']);
  assert.equal(wantsHelp(['analyze', '--root', '.', '--help']), true);
  assert.equal(wantsHelp(['analyze', '-h']), true);
  assert.equal(wantsHelp(['analyze', '--root', '.']), false);
  // `--help` as the VALUE of a flag still asks for help: the rule is read
  // before any other flag, which is the whole point of it.
  assert.equal(wantsHelp(['analyze', '--project', '--help']), true);
});

// ---------------------------------------------------------------------------
// usage.mjs — one text, two readers
// ---------------------------------------------------------------------------

test('usage: the whole text is the header, every command in order, then the footer', () => {
  const whole = usageText();
  assert.ok(whole.startsWith(USAGE_HEADER));
  assert.ok(whole.endsWith(USAGE_FOOTER));
  let at = USAGE_HEADER.length;
  for (const name of COMMANDS) {
    assert.equal(whole.slice(at, at + USAGE[name].length), USAGE[name], `${name} is out of order in the usage text`);
    at += USAGE[name].length;
  }
  assert.equal(at, whole.length - USAGE_FOOTER.length, 'the usage text carries something no command owns');
});

test('usage: the header lists exactly the commands the table carries', () => {
  const listed = /^usage: cascade <([^>]+)>/.exec(USAGE_HEADER)[1].split('|');
  assert.deepEqual(listed, [...COMMANDS]);
});

test('usage: a command section is the same lines with the indent taken off', () => {
  const section = commandUsage('verify');
  assert.ok(section.startsWith('cascade verify '));
  assert.equal(usageText().includes(`  ${section.split('\n')[0]}`), true);
  assert.equal(commandUsage('no-such-command'), null);
});

// ---------------------------------------------------------------------------
// env.mjs — where the engine is, and the small impure edges
// ---------------------------------------------------------------------------

test('env: ENGINE_ROOT is the checkout, and CLI_PATH the binary inside it', () => {
  assert.equal(realPath(ENGINE_ROOT), realPath(ROOT));
  assert.equal(CLI_PATH, realPath(path.join(ROOT, 'bin', 'cascade.mjs')));
  assert.ok(fs.existsSync(CLI_PATH));
  assert.equal(DEFAULT_PASSWORD_ENV, 'CASCADE_DB_PASSWORD');
});

test('env: projectIdFrom takes the first candidate that slugifies, and null for none', () => {
  assert.equal(projectIdFrom(null, 'Mall Admin', 'x'), 'mall-admin');
  assert.equal(projectIdFrom(undefined, null, ''), null);
  assert.equal(projectIdFrom('already-a-slug'), 'already-a-slug');
});

test('env: splitZ reads a NUL-separated git list, and null is an empty one', () => {
  assert.deepEqual(splitZ(`a.java${String.fromCharCode(0)}b/c.xml${String.fromCharCode(0)}`), ['a.java', 'b/c.xml']);
  assert.deepEqual(splitZ(null), []);
});

test('env: parseJsonl drops blank lines; manifestAt is null where there is none', () => {
  assert.deepEqual(parseJsonl('{"a":1}\n\n{"b":2}\n'), [{ a: 1 }, { b: 2 }]);
  assert.equal(manifestAt(null), null);
  assert.equal(manifestAt(path.join(os.tmpdir(), 'cascade-no-such-dir-xyz')), null);
});

test('env: listMapperXml is every .xml under the given directories, sorted and deduplicated', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-mapper-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'b.xml'), '<x/>');
  fs.writeFileSync(path.join(dir, 'a.xml'), '<x/>');
  fs.writeFileSync(path.join(dir, 'note.txt'), 'not a mapper');
  fs.writeFileSync(path.join(dir, 'sub', 'c.xml'), '<x/>');
  assert.deepEqual(
    listMapperXml([dir, dir]).map((f) => path.relative(dir, f)),
    ['a.xml', 'b.xml', path.join('sub', 'c.xml')],
  );
});

// ---------------------------------------------------------------------------
// state.mjs — the hashes a receipt is made of
// ---------------------------------------------------------------------------

test('state: a file that is not there hashes to null, not to a throw', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-state-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'a');
  fs.writeFileSync(file, 'hello');
  const hashed = sha256File(file);
  assert.match(hashed, /^[0-9a-f]{64}$/);
  assert.equal(hashOrNull(file), hashed);
  assert.equal(safeHash(file), hashed);
  assert.equal(hashOrNull(path.join(dir, 'gone')), null);
  assert.equal(safeHash(path.join(dir, 'gone')), null);
});

test('state: relToState spells a path the way the receipt does, and stateDirOf finds the state', () => {
  assert.equal(relToState('/a/b', '/a/b/calibration/gate-state.json'), 'calibration/gate-state.json');
  assert.equal(stateDirOf({ dotCascade: '/a/.cascade' }, '/a/.cascade/pack'), '/a/.cascade');
  // No `.cascade/` at all (a bare `--pack`): the pack's own parent is the state.
  assert.equal(stateDirOf(null, '/somewhere/pack'), path.resolve('/somewhere'));
});

test('state: the engine print is stable within a process and looks like a digest', () => {
  const first = runningEnginePrint();
  assert.match(first, /^[0-9a-f]{8,}$/);
  assert.equal(runningEnginePrint(), first, 'the print is cached, so two readers cannot disagree');
});

// ---------------------------------------------------------------------------
// output.mjs — the stderr conventions
// ---------------------------------------------------------------------------

test('output: listOfFive keeps five names and counts the rest exactly', () => {
  assert.equal(listOfFive(['a', 'b']), 'a, b');
  assert.equal(listOfFive(['a', 'b', 'c', 'd', 'e']), 'a, b, c, d, e');
  assert.equal(listOfFive(['a', 'b', 'c', 'd', 'e', 'f', 'g']), 'a, b, c, d, e, and 2 more');
  assert.equal(listOfFive([]), '');
});

// ---------------------------------------------------------------------------
// lanes_run.mjs — which files a lane is pointed at
// ---------------------------------------------------------------------------

test('lanes_run: --root wins over everything, and a registered project brings its own tree', () => {
  assert.deepEqual(
    analyzeRoot({ source: 'registry', dotCascade: '/reg/.cascade' }, '/given', '/cwd'),
    { root: '/given', from: '--root' },
  );
  assert.deepEqual(
    analyzeRoot({ source: 'local', dotCascade: null }, undefined, '/cwd'),
    { root: path.resolve('/cwd'), from: 'the current directory' },
  );
  // A registered project with no manifest still analyzes its own directory,
  // never the shell's — that was the defect this rule exists for.
  const chosen = analyzeRoot({ source: 'registry', dotCascade: '/reg/.cascade' }, undefined, '/cwd');
  assert.equal(chosen.root, '/reg');
  assert.match(chosen.from, /registered project/);
});

test('lanes_run: a glob expands in typed order with each match sorted, and a miss passes through', (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-ddl-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const name of ['b', 'a']) {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    fs.writeFileSync(path.join(dir, name, 'schema.sql'), 'CREATE TABLE t (id int);');
  }
  const expanded = expandDdlPatterns([path.join(dir, '*', 'schema.sql'), path.join(dir, 'nothing.sql')]);
  assert.deepEqual(expanded, [
    path.join(dir, 'a', 'schema.sql'),
    path.join(dir, 'b', 'schema.sql'),
    // A pattern that matches nothing is passed through UNCHANGED, so the run
    // dies naming what the user typed rather than analysing a smaller set.
    path.join(dir, 'nothing.sql'),
  ]);
  assert.deepEqual(globFiles(path.join(dir, 'no-such-*.sql')), []);
});

test('lanes_run: webPackagesRead finds the nearest package.json above each root, once', (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-web-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'front', 'src', 'views'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'front', 'package.json'), JSON.stringify({ dependencies: { 'vue-router': '4.0.0' } }));
  const read = webPackagesRead([path.join(dir, 'front', 'src'), path.join(dir, 'front', 'src', 'views')]);
  assert.equal(read.length, 1, 'two roots under one package are one package');
  assert.equal(read[0].router, 'vue-router');
});

// ---------------------------------------------------------------------------
// serve.mjs — turning "which project?" into a served pack
// ---------------------------------------------------------------------------

test('serve: --memory-budget is megabytes, and a nonsense one is refused', () => {
  const { args: a } = args(['mcp', '--memory-budget', '8']);
  assert.equal(memoryBudgetBytes(a), 8 * 1024 * 1024);
  assert.equal(memoryBudgetBytes(args(['mcp']).args), 512 * 1024 * 1024);
  assert.throws(() => memoryBudgetBytes(args(['mcp', '--memory-budget', 'lots']).args), /exit:/);
  assert.throws(() => memoryBudgetBytes(args(['mcp', '--memory-budget', '0']).args), /exit:/);
});

test('serve: --pack and --project together are refused rather than resolved by precedence', () => {
  const { said, args: a } = args(['mcp', '--pack', '/tmp/p', '--project', 'mall']);
  assert.throws(() => servedEntries(a, 'mcp'), /exit:/);
  assert.match(said.join(''), /--pack\/--root serve ONE pack/);
});

test('serve: packMeta is what a pack IS, with the fields a pack may not carry as null', () => {
  const meta = packMeta({ digest: 'abc123', meta: { project: 'mall', builtAt: 'T', lanes: ['sql'] } });
  assert.equal(meta.project, 'mall');
  assert.equal(meta.digest, 'abc123');
  assert.deepEqual(meta.lanes, ['sql']);
  assert.equal(meta.identifierCase, null, 'a pack built before the field existed carries none, and no fold is assumed');
  assert.equal(packMeta({ digest: 'd' }).project, 'project');
});

test('serve: runtimeEvidenceBasis is null with no trace, and coverage with one', () => {
  assert.equal(runtimeEvidenceBasis({ meta: {} }), null, 'no trace is not a trace that saw nothing');
  const basis = runtimeEvidenceBasis({ meta: { laneStats: { otel: { spans: 12, observations: 3, sources: ['t.json'] } } } });
  assert.equal(basis.runtimeEvidence.source, 'otel');
  assert.equal(basis.runtimeEvidence.spans, 12);
  assert.deepEqual(basis.runtimeEvidence.files, ['t.json']);
  assert.match(basis.runtimeEvidence.note, /coverage is only what was exercised/);
});

// ---------------------------------------------------------------------------
// overlay_provider.mjs — the reasons an overlay does not happen
// ---------------------------------------------------------------------------

test('overlay: a pack with no web lane declines a profile that now declares one', () => {
  const verdict = refuse({
    session: { state: 'fresh' },
    dirtyFiles: ['front/src/a.vue'],
    entries: [{ path: 'front/src/a.vue', status: 'M' }],
    idx: { selection: { webRoots: [], sqlArgs: [] } },
    profile: { frameworkPacks: ['web'] },
    baseCommit: '0'.repeat(40),
    headCommit: '0'.repeat(40),
  });
  assert.match(verdict.declined, /built without a web lane/);
});

test('overlay: a moved HEAD is discarded rather than laid onto a base that has moved', () => {
  const verdict = refuse({
    session: { state: 'stale' },
    dirtyFiles: [],
    entries: [],
    idx: { selection: {} },
    profile: {},
    baseCommit: 'a'.repeat(40),
    headCommit: 'b'.repeat(40),
  });
  assert.equal(verdict.applied, false);
  assert.equal(verdict.state, 'stale');
  assert.match(verdict.limits[0].reason, /HEAD moved past the pack's base commit/);
});

test('overlay: a dirty DDL declines out loud instead of answering over a stale catalog', () => {
  const verdict = refuse({
    session: { state: 'fresh' },
    dirtyFiles: ['db/schema.sql'],
    entries: [{ path: 'db/schema.sql', status: 'M' }],
    idx: { selection: { ddl: 'db/schema.sql', sqlArgs: ['--dialect', 'mysql', '--identifier-case', 'fold-lower'] } },
    profile: { sql: { dialect: 'mysql' } },
    baseCommit: 'a'.repeat(40),
    headCommit: 'a'.repeat(40),
  });
  assert.equal(verdict.state, 'declined');
  assert.match(verdict.reason, /schema file changed/);
});

// ---------------------------------------------------------------------------
// context.mjs — the one object a command is handed
// ---------------------------------------------------------------------------

test('context: the readers come straight through, and the bound helpers are functions', () => {
  const ctx = makeContext(['mcp', '--memory-budget', '4'], { write: () => {}, exit: () => {} });
  assert.equal(ctx.cmd, 'mcp');
  assert.equal(ctx.opt('memory-budget'), '4');
  assert.equal(ctx.memoryBudgetBytes(), 4 * 1024 * 1024);
  for (const name of ['resolveOrDie', 'readProfile', 'servedEntries', 'servedHost']) {
    assert.equal(typeof ctx[name], 'function', `the context does not carry ${name}`);
  }
  assert.throws(() => { ctx.opt = null; }, 'the context is frozen: a command may read it, never edit it');
});

// ---------------------------------------------------------------------------
// the layering these modules were split under
// ---------------------------------------------------------------------------

/** Every module specifier a JavaScript source imports. */
function importsOf(text) {
  const out = [];
  for (const re of [/(?:^|[\s;])(?:import|export)\s[^;]*?\sfrom\s*['"]([^'"]+)['"]/g,
    /(?:^|[\s;])import\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) out.push(m[1]);
  }
  return out;
}

/** Every `.mjs` under `rel`, recursively, as repository-relative posix paths. */
function mjsUnder(rel) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const child = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(child);
      else if (e.name.endsWith('.mjs')) out.push(child);
    }
  };
  walk(rel);
  return out.sort();
}

test('bin/cascade.mjs imports only src/cli/, and is under 120 lines', () => {
  const text = fs.readFileSync(path.join(ROOT, 'bin', 'cascade.mjs'), 'utf8');
  const lines = text.split('\n').length;
  assert.ok(lines < 120, `bin/cascade.mjs is ${lines} lines; the entry is meant to fit on a screen`);
  const outside = importsOf(text).filter((spec) => !spec.startsWith('../src/cli/'));
  assert.deepEqual(outside, [], 'the entry point knows the CLI layer and nothing else');
});

test('src/cli/ imports the core, the adapters and the mcp layer — never the other way round', () => {
  const files = mjsUnder('src/cli');
  assert.ok(files.length >= 12, `expected the CLI to be split into modules, found ${files.length}`);
  const stray = [];
  for (const rel of files) {
    for (const spec of importsOf(fs.readFileSync(path.join(ROOT, rel), 'utf8'))) {
      if (!spec.startsWith('.')) continue;
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
      if (!/^(src\/(core|adapters|mcp|viewer|cli)|adapters)\//.test(resolved)) {
        stray.push(`${rel}: imports ${spec}`);
      }
    }
  }
  assert.deepEqual(stray, [], 'a CLI module reached somewhere it has no business:\n' + stray.join('\n'));
});

test('nothing outside src/cli/ and bin/ imports src/cli/', () => {
  const others = [...mjsUnder('src/core'), ...mjsUnder('src/adapters'), ...mjsUnder('src/mcp'), ...mjsUnder('src/viewer')];
  const stray = [];
  for (const rel of others) {
    for (const spec of importsOf(fs.readFileSync(path.join(ROOT, rel), 'utf8'))) {
      const resolved = spec.startsWith('.')
        ? path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec))
        : spec;
      if (/(^|\/)cli\//.test(resolved)) stray.push(`${rel}: imports ${spec}`);
    }
  }
  assert.deepEqual(stray, [], 'the CLI is the top of the stack; nothing below it may depend on it:\n' + stray.join('\n'));
});

test('every command in the dispatch table is a module that exports run(ctx)', async () => {
  for (const name of COMMANDS) {
    const file = fs.existsSync(path.join(ROOT, 'src', 'cli', 'commands', `${name}.mjs`))
      ? `../src/cli/commands/${name}.mjs`
      : `../src/cli/commands/${name}/index.mjs`;
    const mod = await import(file);
    assert.equal(typeof mod.run, 'function', `${name} does not export run(ctx)`);
    assert.equal(mod.run.length, 1, `${name}'s run takes exactly the context`);
  }
});
