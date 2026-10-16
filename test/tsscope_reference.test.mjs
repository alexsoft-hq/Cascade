import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import babel from '../adapters/web/vendor/babel-parser.cjs';
import { readScopes } from '../adapters/ts/tsscope.mjs';
import { eachChild } from '../adapters/web/lib/ast.mjs';
import { factsOfFile } from '../adapters/ts/tsfacts.mjs';
import { buildStructure } from '../src/core/structure.mjs';

function bindings(code) {
  const ast = babel.parse(code, { sourceType: 'module', plugins: ['typescript'] });
  const scopes = readScopes(ast), calls = [], declarations = [];
  function visit(node) {
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier') calls.push({ name: node.callee.name, binding: scopes.identity(node.callee), local: scopes.local(node.callee) });
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') declarations.push({ name: node.id.name, binding: scopes.identity(node.id) });
    eachChild(node, visit);
  }
  visit(ast); return { calls, declarations };
}

test('default parameters and nested destructuring expressions cannot see body declarations', () => {
  for (const params of ['x = remote()', '{ x = remote() } = {}', '{ [remote()]: x }', 'x = () => remote()']) {
    const { calls } = bindings(`import {remote} from './remote.js'; function entry(${params}) { function remote() {} return remote(); }`);
    assert.equal(calls[0].binding, null, params);
    assert.equal(calls.at(-1).binding.kind, 'function', params);
  }
});

test('simple and expression-free destructured parameters retain shared body var bindings', () => {
  for (const params of ['remote', '{ remote }', '[remote]', '...remote']) {
    const { calls, declarations } = bindings(`function entry(${params}) { var remote; return remote(); }`);
    assert.equal(calls[0].binding, declarations[0].binding, params);
    assert.equal(calls[0].binding.kind, 'param', params);
    assert.equal(calls[0].binding.redeclared, true, params);
  }
  const { calls, declarations } = bindings('function entry(remote = remote()) { var remote; return remote(); }');
  assert.equal(calls[0].binding.kind, 'param');
  assert.notEqual(calls[0].binding, declarations[0].binding);
  assert.equal(calls[1].binding, declarations[0].binding);
});

test('switch discriminant resolves outside case bindings while all cases share one lexical scope', () => {
  const { calls } = bindings(`import {remote} from './remote.js'; function entry() { switch(remote()) { case 0: const remote = () => 1; remote(); break; default: remote(); } return remote(); }`);
  assert.equal(calls[0].binding, null);
  assert.equal(calls[1].binding.kind, 'const');
  assert.equal(calls[1].binding, calls[2].binding);
  assert.equal(calls[3].binding, null);
});

test('real TS and web parser projections link parameter defaults and switch discriminants to imported functions', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-scope-refs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = "export function remote() { return 'outer'; }";
  const source = `import {remote} from './remote.js';
export function parameter(x = remote()) { function remote() { return 'body'; } return x; }
export function nested({x = remote()} = {}) { function remote() { return 'body'; } return x; }
export function selection() { switch(remote()) { case 'outer': const remote = () => 'inner'; return remote(); } }
`;
  fs.writeFileSync(path.join(root, 'remote.js'), target); fs.writeFileSync(path.join(root, 'entry.js'), source);
  const worker = fileURLToPath(new URL('../adapters/web/webfacts.mjs', import.meta.url));
  const webFacts = execFileSync(process.execPath, [worker, '--root', root, root], { encoding: 'utf8' }).trim().split('\n').map(JSON.parse);
  const tsFacts = [...factsOfFile('remote.ts', target), ...factsOfFile('entry.ts', source)];
  for (const structure of [buildStructure({ webFacts }), buildStructure({ tsFacts })]) {
    const names = new Map(structure.declarations.map((d) => [d.id, d.qualifiedName]));
    const refs = structure.relations.filter((r) => r.type === 'references-call').map((r) => [names.get(r.from), names.get(r.to)]);
    for (const name of ['parameter', 'nested', 'selection']) assert.ok(refs.some(([from, to]) => from === name && to === 'remote'), name);
    assert.ok(refs.some(([from, to]) => from === 'selection' && to === 'selection.remote'));
    assert.ok(!refs.some(([from, to]) => from === 'parameter' && to === 'parameter.remote'));
    assert.ok(!refs.some(([from, to]) => from === 'nested' && to === 'nested.remote'));
  }
});
