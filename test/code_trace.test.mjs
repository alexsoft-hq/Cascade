import test from 'node:test';
import assert from 'node:assert/strict';
import { callTool, toolList } from '../src/mcp/catalog.mjs';
import { assertContract } from '../src/mcp/contract.mjs';
function fixture() {
  const declarations = ['Controller.create', 'Service.create', 'Service.validate', 'format', 'callback'].map((name, i) => ({ id: `d${i}`, name: name.split('.').at(-1), qualifiedName: name, kind: 'method', file: 'src/app.ts', line: i + 1, impactIds: [`symbol:${name}`] }));
  const relations = [
    { from: 'symbol:Controller.create', to: 'symbol:Service.create', type: 'MAY_CALL', grade: 'SOUND_SET', evidence: { rule: 'ts-injected-field', line: 2 } },
    { from: 'd1', to: 'd2', type: 'CALLS', grade: 'EXACT' },
    { from: 'd2', to: 'd3', type: 'references-call', provenance: 'parser-lexical-binding' },
    { from: 'd3', to: 'd4', type: 'references-callback', evidence: { argumentIndex: 0 } },
    { from: 'd4', to: 'd0', type: 'references-call' },
  ];
  const ctx = { graph: {}, basis: { project: 'fixture', buildDigest: 'p1', freshness: { verdict: 'current' } }, structure: { schema: 'cascade:structure:1', digest: 's1', files: [], declarations, relations, coverage: { scope: 'analyzed-inputs', complete: false } } };
  return { ctx, trace: (args) => callTool('code_trace', args, ctx) };
}
test('trace exposes immediate/intermediate Nest declarations and written web references without claiming callback execution', () => {
  const { trace } = fixture();
  const first = trace({ symbol: 'Controller.create', direction: 'outbound' });
  assertContract(first); assert.equal(first.answer.items[0].to.name, 'Service.create');
  assert.equal(first.answer.items[0].grade, 'SOUND_SET'); assert.equal(first.answer.depthLimited, true);
  const all = trace({ symbol: 'd0', direction: 'outbound', depth: 8 });
  assert.equal(all.answer.items.length, 5); assert.equal(all.answer.visitedDeclarations, 5);
  assert.equal(all.answer.items[3].execution, 'callback-reference-not-proven-execution');
  assert.equal(all.answer.items[3].grade, null); assert.equal(all.answer.items[2].provenance, 'parser-lexical-binding');
  assert.equal(all.basis.structureDigest, 's1'); assert.equal(all.basis.freshness.verdict, 'current');
});
test('direction, ambiguity, missing symbols, and stable pagination', () => {
  const { trace } = fixture();
  assert.equal(trace({ symbol: 'd1', direction: 'inbound' }).answer.items[0].from.name, 'Controller.create');
  assert.equal(trace({ symbol: 'd1', direction: 'both' }).answer.items.length, 2);
  assert.throws(() => trace({ symbol: 'create' }), { code: 'ambiguous-symbol' });
  assert.throws(() => trace({ symbol: 'missing' }), { code: 'unknown-symbol' });
  assert.throws(() => trace({ symbol: 'd0', direction: 'sideways' }), { code: 'bad-input' });
  const first = trace({ symbol: 'symbol:Controller.create', depth: 8, direction: 'outbound', limit: 2 });
  const second = trace({ symbol: 'd0', depth: 8, direction: 'outbound', limit: 2, offset: 2 });
  assert.equal(first.truncated.fields[0].nextOffset, 2); assert.equal(second.answer.items[0].hops, 3);
  assert.equal(trace({ symbol: 'd0', offset: 999 }).answer.items.length, 0);
});
test('zero-fit byte cuts expose retry without skipping, and unresolved targets remain explicit', () => {
  const { trace, ctx } = fixture(); ctx.structure.relations[0].evidence.large = 'x'.repeat(10000);
  const result = trace({ symbol: 'd0', direction: 'outbound', maxBytes: 2048 });
  assert.equal(result.answer.items.length, 0); assert.equal(result.truncated.any, true);
  assert.equal(result.truncated.fields[0].retry.offset, 0); assert.equal(result.truncated.fields[0].byteLimited, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result.answer)) <= 2048); assertContract(result);
  ctx.structure.relations = [{ from: 'd0', to: 'external:unknown', type: 'MAY_CALL', grade: 'SOUND_SET' }];
  assert.equal(trace({ symbol: 'd0' }).answer.items[0].to.unresolved, true);
});
test('catalog advertises trace and a materially smaller tool list', () => {
  const catalog = toolList();
  assert.ok(catalog.tools.some((t) => t.name === 'code_trace'));
  assert.ok(Buffer.byteLength(JSON.stringify(catalog)) < 36000);
});
test('real web parser and persisted projection retain local/import/alias/callback distinctions in trace', async (t) => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const { execFileSync } = await import('node:child_process'); const { fileURLToPath } = await import('node:url');
  const { buildStructure } = await import('../src/core/structure.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-trace-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'helper.js'), 'export function helper(x) { return x; }');
  fs.writeFileSync(path.join(root, 'main.js'), 'import { helper } from "./helper.js"; function local(x) { return helper(x); } const alias = local; export function run(xs) { alias(1); xs.map(local); }');
  const facts = execFileSync(process.execPath, [fileURLToPath(new URL('../adapters/web/webfacts.mjs', import.meta.url)), '--root', root, root], { encoding: 'utf8' }).trim().split('\n').map(JSON.parse);
  const { ctx } = fixture(); ctx.structure = buildStructure({ webFacts: facts });
  const result = callTool('code_trace', { symbol: 'run', direction: 'outbound', depth: 3 }, ctx);
  assertContract(result);
  assert.ok(result.answer.items.some((r) => r.to.name === 'local' && r.type === 'references-call'));
  assert.ok(result.answer.items.some((r) => r.to.name === 'helper' && r.hops === 2));
  assert.ok(result.answer.items.some((r) => r.to.name === 'local' && r.type === 'references-callback' && r.execution === 'callback-reference-not-proven-execution'));
  assert.ok(result.answer.items.every((r) => r.grade === null));
});

test('both directions use independent directed walks and never invent co-callers', () => {
  const { ctx, trace } = fixture();
  ctx.structure.declarations = ['A', 'B', 'C'].map((id) => ({ id, name: id, file: 'a.js', line: 1 }));
  ctx.structure.relations = [{ from: 'A', to: 'B', type: 'references-call' }, { from: 'C', to: 'B', type: 'references-call' }];
  const result = trace({ symbol: 'A', direction: 'both', depth: 2 });
  assert.equal(result.answer.items.length, 1);
  assert.equal(result.answer.items[0].to.id, 'B');
  assert.equal(result.answer.visitedDeclarations, 2);
  assert.equal(result.answer.depthLimited, false);
});

test('cycles retain separate inbound/outbound memberships with minimum directed hops and deterministic pages', () => {
  const { ctx, trace } = fixture();
  ctx.structure.declarations = ['A', 'B', 'C'].map((id) => ({ id, name: id, file: 'a.js', line: 1 }));
  ctx.structure.relations = [{ from: 'A', to: 'B', type: 'references-call' }, { from: 'B', to: 'C', type: 'references-call' }, { from: 'C', to: 'A', type: 'references-call' }];
  const args = { symbol: 'A', direction: 'both', depth: 3 };
  const all = trace(args).answer;
  assert.equal(all.items.length, 6);
  assert.equal(all.visitedDeclarations, 3);
  assert.deepEqual(all.items.filter((r) => r.from.id === 'A' && r.to.id === 'B').map((r) => [r.direction, r.hops]), [['outbound', 1], ['inbound', 3]]);
  const pages = [0, 2, 4].flatMap((offset) => trace({ ...args, limit: 2, offset }).answer.items);
  assert.deepEqual(pages, all.items);
  ctx.structure.relations.reverse();
  assert.deepEqual(trace(args).answer.items, all.items);
});

test('exact overload shows ambiguous impact association without attributing it or traversing into its target', () => {
  const { ctx, trace } = fixture();
  ctx.structure.declarations = [
    { id: 'f-string', name: 'f', file: 'A.java', line: 1, impactIds: ['symbol:f'] },
    { id: 'f-number', name: 'f', file: 'A.java', line: 2, impactIds: ['symbol:f'] },
    { id: 'g', name: 'g', file: 'B.java', line: 1, impactIds: ['symbol:g'] },
    { id: 'h', name: 'h', file: 'B.java', line: 2 },
  ];
  ctx.structure.relations = [{ from: 'symbol:f', to: 'symbol:g', type: 'MAY_CALL', grade: 'SOUND_SET' }, { from: 'g', to: 'h', type: 'references-call' }];
  const result = trace({ symbol: 'f-string', direction: 'outbound', depth: 3 });
  assert.equal(result.answer.items.length, 1);
  assert.equal(result.answer.ambiguousImpactRelations, 1);
  assert.equal(result.answer.visitedDeclarations, 1);
  const row = result.answer.items[0];
  assert.deepEqual(row.from.candidateDeclarationIds, ['f-number', 'f-string']);
  assert.equal(row.from.unresolved, true);
  assert.equal(row.execution, 'ambiguous-impact-association-not-overload-proof');
  assert.equal(row.grade, 'SOUND_SET');
  ctx.structure.relations[0].evidence = { large: 'x'.repeat(10000) };
  const cut = trace({ symbol: 'f-string', direction: 'outbound', maxBytes: 2048 });
  assert.equal(cut.answer.items.length, 0);
  assert.equal(cut.answer.ambiguousImpactRelations, 1);
  assert.equal(cut.truncated.fields[0].total, 1);
  assert.equal(cut.truncated.fields[0].retry.offset, 0);
  assert.ok(Buffer.byteLength(JSON.stringify(cut.answer)) <= 2048);
});
