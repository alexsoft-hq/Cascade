// Run the actual worker from an installation path that needs URL decoding.
// Direct imports alone cannot catch a CLI entry guard that never starts it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

test('TypeScript worker lists and reads files from an installation path with URL-encoded characters', (t) => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-ts-worker-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const install = path.join(root, 'installed package #100%');
  const adapters = fileURLToPath(new URL('../adapters/', import.meta.url));
  for (const rel of ['ts', 'web/lib/ast.mjs', 'web/vendor/babel-parser.cjs']) {
    const dest = path.join(install, 'adapters', rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(path.join(adapters, rel), dest, { recursive: true });
  }
  const worker = path.join(install, 'adapters', 'ts', 'tsfacts.mjs');
  const source = path.join(root, 'project #100%');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'a.ts'), 'export const answer = 42;\n');
  const run = (...args) => execFileSync(process.execPath, [worker, '--root', source, ...args], { encoding: 'utf8' })
    .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));

  const listed = run('--list', source);
  assert.equal(listed[0]?.kind, 'header', 'the CLI must start and emit its protocol header');
  assert.deepEqual(listed.filter((r) => r.kind === 'sourceFile'), [{ kind: 'sourceFile', file: 'a.ts' }]);
  const targets = path.join(root, 'targets.txt');
  fs.writeFileSync(targets, `${path.join(source, 'a.ts')}\n`);
  const records = run('--files-from', targets);
  assert.deepEqual(records.filter((r) => r.kind === 'file'), [{ kind: 'file', file: 'a.ts' }]);
  assert.equal(records.at(-1).kind, 'summary');
  assert.equal(records.at(-1).files, 1);
  assert.equal(records.at(-1).parseErrors, 0);

  const imported = execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(worker).href)});`], { encoding: 'utf8' });
  assert.equal(imported, '', 'importing the worker must not start its CLI');
});
