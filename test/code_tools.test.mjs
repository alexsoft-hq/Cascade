import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { callTool, toolList } from '../src/mcp/catalog.mjs';
import { assertContract } from '../src/mcp/contract.mjs';
import { NO_STATE_TRUST_LEVEL } from '../src/core/trust.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-code-tools-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'));
  const text = 'function alpha() {\n  return beta();\n}\nfunction beta() { return 1; }\n';
  fs.writeFileSync(path.join(root, 'src/code.js'), text);
  const sha256 = createHash('sha256').update(text).digest('hex');
  const structure = { schema: 'cascade:structure:1', digest: 's1', inputDigest: 'i1', packDigest: 'p1', coverage: { scope: 'analyzed-inputs', complete: false, limitations: [] }, files: [{ path: 'src/code.js', sha256, status: 'analyzed', hashStatus: 'matches-shard-key' }], declarations: [
    { id: 'alpha', kind: 'function', name: 'alpha', qualifiedName: 'code.alpha', file: 'src/code.js', line: 1, endLine: 3, startOffset: 0, endOffset: text.indexOf('function beta') - 1, offsetEncoding: 'utf16', extent: 'exact' },
    { id: 'beta', kind: 'function', name: 'beta', qualifiedName: 'code.beta', file: 'src/code.js', line: 4, endLine: 4, startOffset: text.indexOf('function beta'), endOffset: text.length - 1, offsetEncoding: 'utf16', extent: 'exact' },
  ], relations: [{ from: 'alpha', to: 'beta', type: 'calls' }] };
  const ctx = { graph: {}, basis: { project: 'test', buildDigest: 'p1', freshness: { verdict: 'unknown' } }, pack: { base: { repoPath: root } }, structure, indexStatus: () => ({ phase: 'idle' }) };
  return { root, text, ctx, call: (tool, args = {}) => callTool(tool, args, ctx) };
}
test('seven structure tools are callable and contract-valid; pagination and absent matches are honest', (t) => {
  const { call, ctx } = fixture(t);
  for (const name of ['architecture', 'code_search', 'file_outline', 'code_context', 'code_snippet', 'index_status', 'session_briefing']) assert.ok(toolList().tools.some((x) => x.name === name));
  const first = call('code_search', { query: 'code', limit: 1 });
  assert.equal(first.answer.items.length, 1); assert.equal(first.truncated.fields[0].total, 3); assert.equal(first.truncated.fields[0].nextOffset, 1);
  const last = call('code_search', { query: 'code', limit: 1, offset: 2 }); assert.equal(last.truncated.any, false);
  const absent = call('code_search', { query: 'not-present' }); assert.equal(absent.answer.empty.items, 'none'); assert.ok(absent.limits.length);
  const outline = call('file_outline', { file: 'src/code.js' }); assert.deepEqual(outline.answer.items.map((x) => x.id), ['alpha', 'beta']);
  for (const r of [first, last, absent, outline, call('architecture'), call('index_status')]) { assertContract(r); assert.equal(r.trust.trustLevel, NO_STATE_TRUST_LEVEL); assert.deepEqual(r.trust.axes, ['structure']); }
  assert.equal(call('architecture').answer.rule.declared, false);
  ctx.structure = null; assert.equal(call('index_status').answer.available, false);
  assert.throws(() => call('code_search', { query: 'x' }), { code: 'structure-unavailable' });
});
test('context is deterministic and respects answer byte budgets with explicit omissions', (t) => {
  const { call, ctx } = fixture(t);
  for (let i = 0; i < 200; i++) ctx.structure.declarations.push({ id: `extra${i}`, name: `alpha${i}`, file: 'src/code.js', qualifiedName: 'x'.repeat(300), kind: 'function' });
  const a = call('code_context', { query: 'alpha', maxBytes: 1024 });
  assert.ok(Buffer.byteLength(JSON.stringify(a.answer)) <= 1024);
  assert.ok(a.answer.omitted.matches > 0);
  assert.deepEqual(a, call('code_context', { query: 'alpha', maxBytes: 1024 }));
  assert.equal(a.answer.matches[0].id, 'alpha');
  assert.throws(() => call('code_context', { query: 'x'.repeat(2000), maxBytes: 1024 }), { code: 'budget-too-small' });
  const empty = call('code_context', { query: 'nothing-matches', maxBytes: 1024 }); assert.equal(empty.answer.empty.matches, 'none');
});
test('snippet verifies bytes, exact extent, bounds and source containment', (t) => {
  const { call, ctx, root, text } = fixture(t);
  const a = call('code_snippet', { symbol: 'alpha' }); assert.equal(a.answer.snippet, text.split('\n').slice(0, 3).join('\n')); assert.equal(a.answer.cut, false);
  const cut = call('code_snippet', { file: 'src/code.js', fromLine: 1, toLine: 4, maxLines: 1 }); assert.equal(cut.answer.cut, true); assert.equal(cut.answer.toLine, 1);
  assert.throws(() => call('code_snippet', { file: '../outside' }), { code: 'unsafe-path' });
  assert.throws(() => call('code_snippet', { file: path.join(root, 'src/code.js') }), { code: 'unsafe-path' });
  ctx.structure.declarations[0].extent = 'start-only'; assert.throws(() => call('code_snippet', { symbol: 'alpha' }), { code: 'unknown-extent' });
  ctx.structure.declarations.push({ ...ctx.structure.declarations[1], id: 'other' }); assert.throws(() => call('code_snippet', { symbol: 'code.beta' }), { code: 'ambiguous' });
  fs.writeFileSync(path.join(root, 'src/code.js'), text + '// changed'); assert.throws(() => call('code_snippet', { file: 'src/code.js' }), { code: 'stale-source' });
  ctx.structure.files[0].sha256 = null; assert.throws(() => call('code_snippet', { file: 'src/code.js' }), { code: 'unverified-source' });
});
test('snippet rejects symbolic links outside root and oversized sources before reading', (t) => {
  const { call, ctx, root } = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-code-outside-')); t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'secret.js'), 'outside');
  fs.symlinkSync(path.join(outside, 'secret.js'), path.join(root, 'link.js'));
  ctx.structure.files.push({ path: 'link.js', sha256: 'a'.repeat(64) });
  assert.throws(() => call('code_snippet', { file: 'link.js' }), { code: 'unsafe-path' });
  fs.writeFileSync(path.join(root, 'large.js'), Buffer.alloc(4 * 1024 * 1024 + 1)); ctx.structure.files.push({ path: 'large.js', sha256: 'a'.repeat(64) });
  assert.throws(() => call('code_snippet', { file: 'large.js' }), { code: 'source-too-large' });
});
test('architecture counts cross-directory dependencies, excludes containment and discloses unresolved imports', (t) => {
  const { call, ctx } = fixture(t);
  ctx.structure.files.push({ path: 'lib/helper.js' });
  ctx.structure.declarations.push({ id: 'helper', file: 'lib/helper.js', name: 'helper', impactIds: ['webfunction:helper'] });
  ctx.structure.relations.push({ from: 'file:src/code.js', to: 'file:lib/helper.js', type: 'imports' }, { from: 'alpha', to: 'helper', type: 'contains' }, { from: 'alpha', to: 'webfunction:helper', type: 'CALLS' }, { from: 'file:src/code.js', to: null, type: 'imports', source: 'external' });
  const a = call('architecture');
  assert.equal(a.answer.items.find((x) => x.module === 'src').dependenciesOut, 2);
  assert.equal(a.answer.items.find((x) => x.module === 'lib').dependenciesIn, 2);
  assert.equal(a.answer.unresolvedRelations, 1);
  const c = call('code_context', { query: 'alpha' });
  assert.ok(c.answer.relatedFiles.includes('lib/helper.js'));
  assert.equal(c.answer.contentTrust, 'untrusted-source-metadata');
  assertContract(c);
});
test('invalid sidecars fail explicitly and snippets classify content as untrusted', (t) => {
  const { call, ctx } = fixture(t);
  assert.equal(call('code_snippet', { symbol: 'alpha' }).answer.contentTrust, 'untrusted-source');
  assertContract(call('code_snippet', { symbol: 'alpha' }));
  ctx.structure = { schema: 'cascade:structure:1' };
  assert.throws(() => call('index_status'), { code: 'structure-invalid' });
  ctx.structure = { schema: 'cascade:structure:future' };
  assert.throws(() => call('file_outline', { file: 'x' }), { code: 'structure-unavailable' });
});
test('architecture exposes directed typed dependencies, bounded evidence and unresolved external references', (t) => {
  const { call, ctx } = fixture(t);
  ctx.structure.files.push({ path: 'lib/target.js' });
  ctx.structure.declarations.push({ id: 'target', name: 'target', file: 'lib/target.js', impactIds: ['symbol:lib/target.js#target'] });
  ctx.graph = { nodes: new Map([['symbol:vendor#send', { external: true }]]) };
  ctx.structure.relations.push({ from: 'file:src/code.js', to: 'file:lib/target.js', type: 'imports', line: 1, resolution: 'relative-file' });
  for (let i = 0; i < 5; i++) ctx.structure.relations.push({ from: 'alpha', to: 'symbol:lib/target.js#target', type: 'MAY_CALL', grade: 'SOUND_SET', evidence: { line: i + 2, rule: 'call-rule' } });
  ctx.structure.relations.push({ from: 'alpha', to: 'symbol:vendor#send', type: 'CALLS' });
  const answer = call('architecture').answer;
  assert.equal(answer.dependencies.length, 2);
  const imports = answer.dependencies.find((d) => d.type === 'imports');
  assert.deepEqual([imports.from, imports.to, imports.provenance], ['src', 'lib', 'written-import']);
  const calls = answer.dependencies.find((d) => d.type === 'MAY_CALL');
  assert.equal(calls.count, 5); assert.deepEqual(calls.grades, { SOUND_SET: 5 });
  assert.equal(calls.examples.length, 3); assert.equal(calls.examplesOmitted, 2);
  assert.equal(calls.examples[0].evidence.rule, 'call-rule');
  assert.equal(answer.unresolved[0].external, true);
  assert.equal(call('architecture', { limit: 1 }).truncated.any, true);
  assert.equal(call('architecture', { limit: 1, offset: 1 }).answer.dependencies.length, 1);
});
test('architecture keeps structural call references separate from graded impact calls', (t) => {
  const { call, ctx } = fixture(t);
  ctx.structure.files.push({ path: 'lib/helper.js' });
  ctx.structure.declarations.push({ id: 'helper', name: 'helper', file: 'lib/helper.js' });
  ctx.structure.relations.push({ from: 'alpha', to: 'helper', type: 'references-call', resolution: 'written-import-binding', evidence: { callee: 'helper' } });
  const edge = call('architecture').answer.dependencies.find((d) => d.type === 'references-call');
  assert.deepEqual([edge.from, edge.to, edge.provenance], ['src', 'lib', 'structural-call-reference']);
  assert.deepEqual(edge.grades, {});
  assert.equal(edge.examples[0].grade, null);
  assert.equal(edge.examples[0].resolution, 'written-import-binding');
});
test('architecture byte cuts preserve totals and explicit paging, including rows too large for a page', (t) => {
  const { call, ctx } = fixture(t);
  for (let i = 0; i < 25; i++) {
    const file = `module${i}/target.js`; ctx.structure.files.push({ path: file });
    ctx.structure.relations.push({ from: 'file:src/code.js', to: `file:${file}`, type: 'imports' });
  }
  const result = call('architecture', { maxBytes: 2048 });
  assert.ok(Buffer.byteLength(JSON.stringify(result.answer)) <= 2048);
  assert.equal(result.answer.totals.dependencies, 25);
  assert.ok(result.answer.omitted.dependencies > 0);
  assert.equal(result.answer.paging.dependencies.byteLimited, true);
  assertContract(result);
  const large = ctx.structure.relations.find((r) => r.type === 'imports'); large.evidence = { reason: 'x'.repeat(5000) };
  const blocked = call('architecture', { maxBytes: 2048 });
  assert.ok(Buffer.byteLength(JSON.stringify(blocked.answer)) <= 2048);
});
test('briefing is copyable and bounded, with only recorded served routes or screens as entrypoints', (t) => {
  const { call, ctx } = fixture(t);
  ctx.graph = { nodes: new Map([
    ['endpoint:GET /orders', { id: 'endpoint:GET /orders', kind: 'endpoint', httpMethod: 'GET', path: '/orders', handler: 'Orders#get', file: 'src/code.js' }],
    ['endpoint:GET /outbound', { id: 'endpoint:GET /outbound', kind: 'endpoint', httpMethod: 'GET', path: '/outbound' }],
    ['screen:/orders', { id: 'screen:/orders', kind: 'screen', path: '/orders', component: 'web/orders.vue' }],
  ]), edges: [] };
  const result = call('session_briefing', { maxBytes: 4096 });
  assertContract(result);
  assert.equal(result.answer.summary.files, 1);
  assert.equal(result.answer.entrypoints.length, 2);
  assert.ok(result.answer.entrypoints.every((x) => x.path !== '/outbound'));
  assert.match(result.answer.text, /1 analyzed files/);
  assert.match(result.answer.text, /not business architecture/);
  assert.match(result.answer.workflow.inspect, /code_snippet/);
  assert.equal(result.answer.freshness.verdict, 'unknown');
  assert.ok(Buffer.byteLength(JSON.stringify(result.answer)) <= 4096);
  assert.deepEqual(result, call('session_briefing', { maxBytes: 4096 }));
});
test('exact symbol snippets use parser UTF-16 offsets and exclude same-line neighbors', (t) => {
  const { call, ctx, root } = fixture(t);
  const source = '/* 😀 */ function first() { return 1; } function second() { return 2; }';
  fs.writeFileSync(path.join(root, 'src/code.js'), source);
  ctx.structure.files[0].sha256 = createHash('sha256').update(source).digest('hex');
  ctx.structure.declarations = [{ id: 'first', qualifiedName: 'first', file: 'src/code.js', line: 1, endLine: 1, extent: 'exact', startOffset: source.indexOf('function first'), endOffset: source.indexOf(' function second'), offsetEncoding: 'utf16' }];
  const answer = call('code_snippet', { symbol: 'first' }).answer;
  assert.equal(answer.snippet, 'function first() { return 1; }');
  assert.equal(answer.fromLine, 1); assert.equal(answer.toLine, 1); assert.equal(answer.cut, false);
  assert.equal(answer.returnedEndOffset, ctx.structure.declarations[0].endOffset);
  delete ctx.structure.declarations[0].startOffset;
  assert.throws(() => call('code_snippet', { symbol: 'first' }), { code: 'unknown-extent' });
});
test('outline preserves parser source order for multiple declarations on the same line', (t) => {
  const { call, ctx } = fixture(t);
  ctx.structure.declarations = [
    { id: 'aaa-later', file: 'src/code.js', name: 'later', line: 1, startOffset: 40, startColumn: 41 },
    { id: 'zzz-first', file: 'src/code.js', name: 'first', line: 1, startOffset: 0, startColumn: 1 },
  ];
  assert.deepEqual(call('file_outline', { file: 'src/code.js' }).answer.items.map((d) => d.name), ['first', 'later']);
});
test('byte-blocked first architecture row stays explicitly truncated without skipping an unseen row', (t) => {
  const { call, ctx } = fixture(t);
  ctx.structure.files = [{ path: `${'x'.repeat(5000)}/a.js` }];
  ctx.structure.declarations = []; ctx.structure.relations = [];
  const result = call('architecture', { maxBytes: 2048 });
  assert.equal(result.answer.items.length, 0);
  assert.equal(result.answer.empty.items, 'not-in-this-axis');
  assert.equal(result.truncated.any, true);
  const field = result.truncated.fields.find((f) => f.field === 'items');
  assert.equal(field.nextOffset, null); assert.equal(field.byteLimited, true);
  assert.deepEqual(field.retry, { action: 'increase-maxBytes', offset: 0 });
  assert.ok(Buffer.byteLength(JSON.stringify(result.answer)) <= 2048);
  assertContract(result);
});
test('real TypeScript parser declarations reach exact snippets with Unicode, CRLF and same-line neighbors', async (t) => {
  const { factsOfFile } = await import('../adapters/ts/tsfacts.mjs');
  const { buildStructure } = await import('../src/core/structure.mjs');
  const { call, ctx, root } = fixture(t);
  const source = '/* 😀 */ export function first(x: string): string { return x; } function second() { return 2; }\r\nclass Box { get value(): string { return "ok"; } }';
  const file = 'src/code.ts'; fs.writeFileSync(path.join(root, file), source);
  ctx.structure = buildStructure({ tsFacts: factsOfFile(file, source), sourceHashes: { [file]: createHash('sha256').update(source).digest('hex') } });
  const declaration = ctx.structure.declarations.find((d) => d.name === 'first');
  assert.equal(declaration.extent, 'exact');
  const result = call('code_snippet', { symbol: declaration.id });
  assert.equal(result.answer.snippet, 'function first(x: string): string { return x; }');
  assert.equal(result.answer.cut, false); assertContract(result);
  const getter = ctx.structure.declarations.find((d) => d.name === 'value');
  assert.equal(call('code_snippet', { symbol: getter.id }).answer.snippet, 'get value(): string { return "ok"; }');
});
test('real Vue script/setup parser offsets select only the chosen function', async (t) => {
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const { buildStructure } = await import('../src/core/structure.mjs');
  const { call, ctx, root } = fixture(t);
  const source = '<template><div>😀</div></template>\r\n<script setup lang="ts">const one = () => 1; const two = () => 2;</script>\r\n';
  const file = 'src/code.vue'; fs.writeFileSync(path.join(root, file), source);
  const worker = fileURLToPath(new URL('../adapters/web/webfacts.mjs', import.meta.url));
  const facts = execFileSync(process.execPath, [worker, '--root', root, path.join(root, 'src')], { encoding: 'utf8' }).trim().split('\n').map(JSON.parse);
  ctx.structure = buildStructure({ webFacts: facts, sourceHashes: { [file]: createHash('sha256').update(source).digest('hex') } });
  const declaration = ctx.structure.declarations.find((d) => d.file === file && d.name === 'one');
  assert.ok(declaration); assert.equal(declaration.extent, 'exact');
  const result = call('code_snippet', { symbol: declaration.id });
  assert.equal(result.answer.snippet, '() => 1');
  assert.equal(result.answer.fromLine, 2); assert.equal(result.answer.toLine, 2);
  assertContract(result);
});
