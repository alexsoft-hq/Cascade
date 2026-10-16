import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { factsOfFile } from '../adapters/ts/tsfacts.mjs';
import { buildStructure } from '../src/core/structure.mjs';
import { findJdk } from '../src/cli/env.mjs';
import { runJavaLane } from '../src/cli/lanes_run.mjs';
import { splitJavaFactsByFile, assembleJavaFacts } from '../src/core/facts_store.mjs';

function scratch(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-outline-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('TS parser supplies exact UTF16 exclusive ranges, overloads, arrows and nested declarations', () => {
  const code = '// 😀\r\nexport function a(x: string): string;\r\nexport function a(x: number): number;\r\nexport function a(x: unknown) { function inner() {} return x; } const arrow = (x: string): string => x; const neighbor = () => 2;';
  const s = buildStructure({ tsFacts: factsOfFile('a.ts', code) });
  const overloads = s.declarations.filter((d) => d.name === 'a');
  assert.equal(overloads.length, 3);
  assert.equal(new Set(overloads.map((d) => d.id)).size, 3);
  assert.equal(s.declarations.find((d) => d.name === 'inner').owner, 'a');
  const arrow = s.declarations.find((d) => d.name === 'arrow');
  assert.equal(arrow.signature, '(x: string): string =>');
  assert.equal(code.slice(arrow.startOffset, arrow.endOffset), '(x: string): string => x');
  for (const d of s.declarations) assert.equal(d.offsetEncoding, 'utf16');
});

test('web Vue script setup and multiple blocks map exact offsets to the original file', (t) => {
  const root = scratch(t);
  const code = '<template>😀</template>\r\n<script>function first() {} function next() {}</script>\r\n<script setup lang="ts">const arrow = (x: number) => x; class Client { constructor() {} run(): number { return 1; } }</script>';
  fs.writeFileSync(path.join(root, 'view.vue'), code);
  const worker = fileURLToPath(new URL('../adapters/web/webfacts.mjs', import.meta.url));
  const webFacts = execFileSync(process.execPath, [worker, '--root', root, root], { encoding: 'utf8' }).trim().split('\n').map(JSON.parse);
  const s = buildStructure({ webFacts });
  const first = s.declarations.find((d) => d.name === 'first');
  assert.equal(code.slice(first.startOffset, first.endOffset), 'function first() {}');
  assert.equal(first.startColumn, 9);
  const arrow = s.declarations.find((d) => d.name === 'arrow');
  assert.equal(code.slice(arrow.startOffset, arrow.endOffset), '(x: number) => x');
  const ctor = s.declarations.find((d) => d.kind === 'constructor');
  assert.equal(code.slice(ctor.startOffset, ctor.endOffset), 'constructor() {}');
  assert.equal(ctor.owner, 'Client');
});

test('real Java parser distinguishes same-arity overloads and constructors with stable cached extents', (t) => {
  const jdk = findJdk();
  if (!jdk) return t.skip('no JDK found; see docs/setup/java-lane.md');
  const root = scratch(t);
  const code = 'package demo;\npublic class Client { Client() {} Client(String x) {} public String run(String x) { return x; } public int run(int x) { return x; } }';
  fs.writeFileSync(path.join(root, 'Client.java'), code);
  const facts = runJavaLane(jdk, root, [root], { quiet: true });
  const s = buildStructure({ javaFacts: facts });
  const methods = s.declarations.filter((d) => d.name === 'run');
  assert.equal(methods.length, 2);
  assert.notEqual(methods[0].id, methods[1].id);
  assert.equal(s.declarations.filter((d) => d.kind === 'constructor').length, 2);
  assert.ok(methods.some((d) => d.signature === 'public String run(String x)'));
  for (const d of methods) assert.ok(code.slice(d.startOffset, d.endOffset).startsWith(d.signature));
  const shards = splitJavaFactsByFile(facts);
  assert.deepEqual(buildStructure({ javaFacts: assembleJavaFacts(shards.byFile) }), s);
});

test('TS interface member signatures and anonymous default exports have parser extents', () => {
  const code = 'export interface Service { run(x: string): number; new (x: string): Service; } export default function(x: string) { return x; }';
  const s = buildStructure({ tsFacts: factsOfFile('service.ts', code) });
  const run = s.declarations.find((d) => d.qualifiedName === 'Service.run');
  assert.equal(run.kind, 'method');
  assert.equal(run.signature, 'run(x: string): number;');
  assert.equal(code.slice(run.startOffset, run.endOffset), run.signature);
  assert.ok(s.declarations.some((d) => d.kind === 'constructor' && d.owner === 'Service'));
  assert.equal(s.declarations.find((d) => d.name === 'default').extent, 'exact');
});
