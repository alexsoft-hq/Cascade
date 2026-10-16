import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { factsOfFile } from '../adapters/ts/tsfacts.mjs';
import { buildStructure } from '../src/core/structure.mjs';
import { splitTsFactsByFile, assembleTsFacts, splitWebFactsByFile, assembleWebFacts } from '../src/core/facts_store.mjs';

const source = `import { remote } from './remote.js';
function local(x) { return x; }
const arrow = (x) => x;
const alias = local;
const importedAlias = remote;
export function entry(xs) { local(1); arrow(2); alias(3); importedAlias(4); xs.map(remote); return xs.map(local); }
export function shadow(local) { return local(1); }
export function nested() { const local = (n) => n; return local(1); }
let mutable = local;
export function denied() { mutable(1); return unknown(); }
function changed() { return 1; }
changed = arrow;
export function deniedChanged() { return changed(); }
export function callbackAlias(xs) { return xs.map(alias); }
export function anonymousBoundary(xs) { return xs.map(() => local(1)); }
`;
const remote = 'export function remote(x) { return x; }';
function pairs(s) {
  const names = new Map(s.declarations.map((d) => [d.id, d.qualifiedName]));
  return s.relations.filter((r) => r.type.startsWith('references-')).map((r) => [names.get(r.from), names.get(r.to), r.type, r.resolution]);
}
function assertReferences(s) {
  const ps = pairs(s);
  assert.ok(ps.some(([a,b,t]) => a === 'entry' && b === 'local' && t === 'references-call'));
  assert.ok(ps.some(([a,b,t,r]) => a === 'entry' && b === 'local' && t === 'references-call' && r === 'immutable-alias-binding'));
  assert.ok(ps.some(([a,b,t]) => a === 'entry' && b === 'remote' && t === 'references-call'));
  assert.ok(ps.some(([a,b,t]) => a === 'entry' && b === 'local' && t === 'references-callback'));
  assert.ok(ps.some(([a,b,t]) => a === 'entry' && b === 'remote' && t === 'references-callback'));
  assert.ok(ps.some(([a,b,t]) => a === 'callbackAlias' && b === 'local' && t === 'references-callback'));
  assert.ok(ps.some(([a,b]) => a === 'nested' && b === 'nested.local'));
  assert.ok(!ps.some(([a]) => ['shadow', 'denied', 'deniedChanged', 'anonymousBoundary'].includes(a)));
  assert.ok(s.relations.filter((r) => r.type.startsWith('references-')).every((r) => !('grade' in r)));
}

test('TS lexical declarations, immutable aliases and callback references preserve boundaries and cached parity', () => {
  const facts = [...factsOfFile('main.ts', source), ...factsOfFile('remote.js', remote)];
  const s = buildStructure({ tsFacts: facts });
  assertReferences(s);
  const split = splitTsFactsByFile(facts);
  assert.deepEqual(buildStructure({ tsFacts: assembleTsFacts(split) }), s);
});

test('real web worker emits the same safe references with cached parity', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-ref-hardening-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'main.js'), source);
  fs.writeFileSync(path.join(root, 'remote.js'), remote);
  const worker = fileURLToPath(new URL('../adapters/web/webfacts.mjs', import.meta.url));
  const facts = execFileSync(process.execPath, [worker, '--root', root, root], { encoding: 'utf8' }).trim().split('\n').map(JSON.parse);
  const s = buildStructure({ webFacts: facts });
  assertReferences(s);
  const split = splitWebFactsByFile(facts);
  assert.deepEqual(buildStructure({ webFacts: assembleWebFacts(split.byFile) }), s);
});

test('unresolved namespaces, dynamic members, reexports and mutable imports never become guessed references', () => {
  const code = `import * as ns from './remote.js'; import { remote } from './barrel.js'; export function run(xs) { ns.remote(); xs.map(ns.remote); remote(); }`;
  const facts = [...factsOfFile('main.ts', code), ...factsOfFile('remote.js', remote), ...factsOfFile('barrel.js', "export { remote } from './remote.js';")];
  assert.deepEqual(pairs(buildStructure({ tsFacts: facts })), []);
  const writes = factsOfFile('mutated.ts', `import { remote } from './remote.js'; remote = () => 1; export function run(){ remote(); }`);
  assert.deepEqual(pairs(buildStructure({ tsFacts: [...writes, ...factsOfFile('remote.js', remote)] })), []);
});

test('reassigned exports and dynamic lexical scopes do not fall back to legacy name-based calls', () => {
  for (const target of [
    'export function remote() {} remote = () => 1;',
    'export function remote() {} eval("remote = other");',
  ]) {
    const caller = factsOfFile('main.ts', "import { remote } from './remote.js'; export function entry(){ remote(); }");
    assert.deepEqual(pairs(buildStructure({ tsFacts: [...caller, ...factsOfFile('remote.js', target)] })), []);
  }
  const dynamic = factsOfFile('main.ts', 'function local(){} export function entry(){ eval("local=other"); local(); }');
  assert.deepEqual(pairs(buildStructure({ tsFacts: dynamic })), []);
});

test('stable exported aliases/default functions resolve without treating export spelling as declaration identity', () => {
  const facts = [...factsOfFile('main.ts', "import def, { renamed } from './target.js'; export function run(){ def(); renamed(); }"),
    ...factsOfFile('target.js', 'function original(){} const alias = original; export { alias as renamed }; export default function defaultFn(){}')];
  const ps = pairs(buildStructure({ tsFacts: facts }));
  assert.ok(ps.some(([a,b]) => a === 'run' && b === 'original'));
  assert.ok(ps.some(([a,b]) => a === 'run' && b === 'defaultFn'));
});

const exportCases = {
  'consumer.ts': "import def from './default.ts'; import { hidden } from './types.ts'; import { hidden as mixed } from './mixed.ts'; import forwarded from './forwarded.ts'; export function run(){ def(); hidden(); mixed(); forwarded(); }",
  'default.ts': 'function target(){ return 42; } export default target;',
  'types.ts': 'function hidden(){} export type { hidden };',
  'mixed.ts': 'function hidden(){} export { type hidden };',
  'forwarded.ts': "import target from './default.ts'; export default target;",
};
function assertExportCases(s) {
  const ps = pairs(s);
  assert.deepEqual(ps.map(([from, to, type]) => [from, to, type]), [['run', 'target', 'references-call']]);
}

test('TS default identifier export resolves while both type-only export forms remain absent', async () => {
  const facts = Object.entries(exportCases).flatMap(([file, code]) => factsOfFile(file, code));
  const s = buildStructure({ tsFacts: facts });
  assertExportCases(s);
  assert.deepEqual(buildStructure({ tsFacts: assembleTsFacts(splitTsFactsByFile(facts)) }), s);
  const runtime = await import(`data:text/javascript,${encodeURIComponent(exportCases['default.ts'])}`);
  assert.equal(runtime.default(), 42, 'the default identifier actually exports the function at runtime');
});

test('real web TS parser preserves default versus type-only exports and cold/cached parity', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-export-refs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [file, code] of Object.entries(exportCases)) fs.writeFileSync(path.join(root, file), code);
  const worker = fileURLToPath(new URL('../adapters/web/webfacts.mjs', import.meta.url));
  const facts = execFileSync(process.execPath, [worker, '--root', root, root], { encoding: 'utf8' }).trim().split('\n').map(JSON.parse);
  const s = buildStructure({ webFacts: facts });
  assertExportCases(s);
  assert.deepEqual(buildStructure({ webFacts: assembleWebFacts(splitWebFactsByFile(facts).byFile) }), s);
});
