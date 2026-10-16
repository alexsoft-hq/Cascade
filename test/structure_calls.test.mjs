import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildStructure } from '../src/core/structure.mjs';
import { Graph } from '../src/core/graph.mjs';
import { splitWebFactsByFile, assembleWebFacts } from '../src/core/facts_store.mjs';

test('written import calls supplement structure without impact edges, guessing shadowed bindings or ambiguous declarations', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-written-calls-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'money.js'), 'export function formatMoney(n) { return String(n); }');
  fs.writeFileSync(path.join(root, 'orders.js'), `import { formatMoney as format } from './money.js';
export function orderLabel(order) { return format(order.total); }
export function shadowed(format) { return format(1); }
export function localOnly() { const local = () => 1; return local(); }
export function unknown() { return missing(); }
`);
  const worker = fileURLToPath(new URL('../adapters/web/webfacts.mjs', import.meta.url));
  const facts = execFileSync(process.execPath, [worker, '--root', root, root], { encoding: 'utf8' }).trim().split('\n').map(JSON.parse);
  const graph = new Graph();
  const s = buildStructure({ webFacts: facts, graph });
  const refs = s.relations.filter((r) => r.type === 'references-call' && r.resolution === 'written-import-binding');
  assert.equal(refs.length, 1);
  assert.equal(s.declarations.find((d) => d.id === refs[0].from).name, 'orderLabel');
  assert.equal(s.declarations.find((d) => d.id === refs[0].to).name, 'formatMoney');
  assert.equal(refs[0].resolution, 'written-import-binding');
  assert.equal('grade' in refs[0], false);
  assert.equal(graph.edges.length, 0);
  const target = facts.find((r) => r.kind === 'declaration' && r.name === 'formatMoney');
  const ambiguous = buildStructure({ webFacts: [...facts, { ...target }] });
  assert.equal(ambiguous.relations.filter((r) => r.type === 'references-call' && r.resolution === 'written-import-binding').length, 0);
  const competingFiles = facts.map((r) => r.kind === 'structural-reference' && r.source ? { ...r, source: './money' } : r.kind === 'call' && r.binding?.kind === 'import' ? { ...r, binding: { ...r.binding, source: './money' } } : r);
  competingFiles.push({ kind: 'file', file: 'money.ts' });
  assert.equal(buildStructure({ webFacts: competingFiles }).relations.filter((r) => r.type === 'references-call' && r.resolution === 'written-import-binding').length, 0);
  const shards = splitWebFactsByFile(facts);
  assert.deepEqual(buildStructure({ webFacts: assembleWebFacts(shards.byFile) }), s);
});
