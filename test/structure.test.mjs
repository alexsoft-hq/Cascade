import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildStructure, matchingSourceHashes, structureMetadata, validateStructure } from '../src/core/structure.mjs';
import { Graph } from '../src/core/graph.mjs';
import { projectPack } from '../src/core/pack.mjs';
import { emptyIndex, javaShardKey, splitTsFactsByFile, assembleTsFacts } from '../src/core/facts_store.mjs';
import { factsOfFile } from '../adapters/ts/tsfacts.mjs';
import { publishPack } from '../src/cli/commands/analyze/write.mjs';

test('real TS facts retain declaration extents, imports and ownership without changing impact', () => {
  const tsFacts = factsOfFile('src/a.ts', 'import { B } from "./b";\nexport class A {\n  run(x: string) { return x; }\n}\nexport function helper() {}');
  const b = factsOfFile('src/b.ts', 'export class B {}');
  const graph = new Graph();
  graph.addNode({ id: 'symbol:src/a.ts#A.run', symbol: 'src/a.ts#A.run' });
  const before = projectPack(graph);
  const s = buildStructure({ tsFacts: [...tsFacts, ...b], graph });
  const run = s.declarations.find((d) => d.name === 'run');
  assert.equal(run.extent, 'exact');
  assert.equal(run.line, 3);
  assert.equal(run.endLine, 3);
  assert.deepEqual(run.params, ['x: string']);
  assert.deepEqual(run.impactIds, ['symbol:src/a.ts#A.run']);
  assert.ok(s.relations.some((r) => r.type === 'imports' && r.to === 'file:src/b.ts'));
  assert.equal(s.declarations.find((d) => d.name === 'helper').endLine, 5);
  assert.deepEqual(projectPack(graph), before);
  assert.equal(validateStructure(s), s);
});

test('available Java overloads remain separate, with the census omission disclosed', () => {
  const graph = new Graph();
  graph.addNode({ id: 'symbol:app.A#run', symbol: 'app.A#run' });
  const javaFacts = [{ kind: 'type', fqn: 'app.A', typeKind: 'CLASS', file: 'A.java', declaredMethods: ['run/1', 'run/2'], declaredMethodLines: [3, 9] },
    { kind: 'method', fqn: 'app.A#run', owner: 'app.A', name: 'run', paramCount: 1, line: 3, file: 'A.java' }];
  const s = buildStructure({ javaFacts, graph });
  const methods = s.declarations.filter((d) => d.kind === 'method');
  assert.equal(methods.length, 2);
  assert.equal(new Set(methods.map((d) => d.id)).size, 2);
  assert.ok(methods.every((d) => d.endLine === null && d.impactIds[0] === 'symbol:app.A#run'));
  assert.ok(s.coverage.limitations.some((v) => v.includes('same-arity')));
});

test('web records preserve spans; parse errors and unknown hashes remain explicit', () => {
  const s = buildStructure({ webFacts: [{ kind: 'function', file: '../front/a.js', name: 'run', line: 2, endLine: 8, params: 2 },
    { kind: 'parse_error', file: 'bad.js', recovered: false }, { kind: 'file', file: 'large.js', skipped: 'too-large' }] });
  assert.equal(s.declarations[0].arity, 2);
  assert.equal(s.files.find((f) => f.path === '../front/a.js').external, true);
  assert.equal(s.files.find((f) => f.path === 'bad.js').status, 'parse-error');
  assert.equal(s.files.find((f) => f.path === 'large.js').status, 'skipped');
  assert.ok(s.files.every((f) => f.sha256 === null));
  assert.equal(s.coverage.complete, false);
});

test('real web worker class methods retain ownership while object functions do not become class methods', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-structure-web-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'client.js'), 'export class Client { run() { return 1; } }\nexport const other = { run() { return 2; } };');
  const worker = fileURLToPath(new URL('../adapters/web/webfacts.mjs', import.meta.url));
  const records = execFileSync(process.execPath, [worker, '--root', root, root], { encoding: 'utf8' }).split('\n').filter(Boolean).map(JSON.parse);
  const graph = new Graph();
  graph.addNode({ id: 'symbol:client.js#Client.run', symbol: 'client.js#Client.run' });
  const s = buildStructure({ webFacts: records, graph });
  const cls = s.declarations.find((d) => d.kind === 'class' && d.name === 'Client');
  const method = s.declarations.find((d) => d.qualifiedName === 'Client.run');
  assert.equal(method.owner, 'Client');
  assert.equal(method.kind, 'method');
  assert.equal(method.name, 'run');
  assert.deepEqual(method.impactIds, ['symbol:client.js#Client.run']);
  assert.ok(s.relations.some((r) => r.type === 'contains' && r.from === cls.id && r.to === method.id));
  const objectFunction = s.declarations.find((d) => d.qualifiedName === 'run');
  assert.equal(objectFunction.owner, null);
  assert.equal(objectFunction.kind, 'function');
  const dotted = buildStructure({ webFacts: [{ kind: 'class', file: 'other.js', name: 'Client', methods: ['run'] },
    { kind: 'function', file: 'client.js', name: 'Client.run', line: 1, endLine: 1 }] });
  assert.equal(dotted.declarations.find((d) => d.file === 'client.js').owner, null, 'a dotted name and a class in another file are insufficient');
});

test('fact shard hashes are never confused with source hashes; changed bytes fail key verification', () => {
  const source = 'a'.repeat(64);
  const index = { workers: { java: 'javafacts/test' }, files: { 'A.java': {
    lane: 'java', shardKey: javaShardKey({ path: 'A.java', contentSha256: source, workerVersion: 'javafacts/test' }), sha256: 'b'.repeat(64),
  } } };
  const hashes = matchingSourceHashes(index, () => source);
  assert.deepEqual(hashes, { 'A.java': source });
  assert.deepEqual(matchingSourceHashes(index, () => 'c'.repeat(64)), {});
  const s = buildStructure({ factsIndex: index, sourceHashes: hashes });
  assert.equal(s.files[0].sha256, source);
  assert.equal(buildStructure({ factsIndex: index }).files[0].sha256, null);
});

test('cold and cached TS facts project identically; deletion removes declarations', () => {
  const a = factsOfFile('a.ts', 'export function a() {}');
  const b = factsOfFile('b.ts', 'export class B {}');
  const shards = splitTsFactsByFile([...a, ...b]);
  const cold = buildStructure({ tsFacts: [...a, ...b] });
  assert.deepEqual(buildStructure({ tsFacts: assembleTsFacts(shards) }), cold);
  shards.delete('b.ts');
  const next = buildStructure({ tsFacts: assembleTsFacts(shards) });
  assert.equal(next.declarations.some((d) => d.file === 'b.ts'), false);
  assert.notEqual(next.digest, cold.digest);
});

test('structure-only changes have their own generation and cannot pair with the old pack metadata', () => {
  const graph = new Graph();
  const pack = projectPack(graph);
  const first = buildStructure({ tsFacts: factsOfFile('a.ts', 'class A {}'), packDigest: pack.digest });
  pack.meta.structure = structureMetadata(first);
  assert.equal(validateStructure(first, { pack }), first);
  const second = buildStructure({ tsFacts: factsOfFile('a.ts', 'class B {}'), packDigest: pack.digest });
  assert.notEqual(first.digest, second.digest);
  assert.throws(() => validateStructure(second, { pack }), /different pack generation/);
  assert.throws(() => validateStructure({ ...first, declarations: [] }), /digest mismatch/);
});

test('publish writes validated structure beside its pack under the existing lock', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-structure-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pack = projectPack(new Graph());
  const structure = buildStructure({ packDigest: pack.digest });
  pack.meta.structure = structureMetadata(structure);
  const index = emptyIndex({ project: 'p', engineVersion: 'v', workers: {}, root: dir, selection: {} });
  publishPack(dir, { pack, index, structure, keep: false });
  const read = JSON.parse(fs.readFileSync(path.join(dir, 'structure.json'), 'utf8'));
  assert.deepEqual(validateStructure(read, { pack: JSON.parse(fs.readFileSync(path.join(dir, 'pack.json'), 'utf8')) }), structure);
  assert.throws(() => publishPack(dir, { pack, index, structure: { ...structure, digest: 'bad' }, keep: false }), /digest mismatch/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'structure.json'), 'utf8')), structure);
});

test('real analyze cold/incremental runs persist identical structure and verified hashes, then remove deleted files', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-structure-cli-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/a.ts'), 'export class A { run(x: string) { return x; } }');
  fs.writeFileSync(path.join(root, 'src/b.ts'), 'export class B {}');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['add', 'src'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'], { cwd: root });
  const cli = fileURLToPath(new URL('../bin/cascade.mjs', import.meta.url));
  const out = path.join(root, 'out');
  const run = (mode, sourceRoot = path.join(root, 'src')) => {
    execFileSync(process.execPath, [cli, 'analyze', '--root', root, '--out', out, '--ts-src', sourceRoot, '--no-java', '--no-web', '--no-ddl', '--no-mappers', '--no-openapi', mode], { cwd: root, stdio: 'pipe' });
    const pack = JSON.parse(fs.readFileSync(path.join(out, 'pack.json'), 'utf8'));
    const structure = JSON.parse(fs.readFileSync(path.join(out, 'structure.json'), 'utf8'));
    return validateStructure(structure, { pack });
  };
  const cold = run('--cold');
  assert.deepEqual(run('--incremental'), cold);
  assert.ok(cold.files.every((f) => f.sha256?.length === 64 && !f.external), JSON.stringify(cold.files));
  assert.deepEqual(cold.files.map((f) => f.path), ['src/a.ts', 'src/b.ts']);
  // An explicit source root can spell the same directory differently from
  // the canonical project root (symlinks, or Windows short temp-directory names).
  const alias = `${root}-alias`;
  fs.symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  t.after(() => fs.rmSync(alias, { recursive: true, force: true }));
  assert.deepEqual(run('--cold', path.join(alias, 'src')), cold);
  assert.deepEqual(run('--incremental', path.join(alias, 'src')), cold);
  fs.unlinkSync(path.join(root, 'src/b.ts'));
  const changed = run('--incremental');
  assert.equal(changed.files.some((f) => f.path === 'src/b.ts'), false);
  assert.notEqual(changed.inputDigest, cold.inputDigest);
});
