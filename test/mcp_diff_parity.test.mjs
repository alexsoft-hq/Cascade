// mcp_diff_parity.test.mjs — MCP compares the pack bytes, not Graph's defaults.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Graph, nodeId } from '../src/core/graph.mjs';
import { digest12 } from '../src/core/canonical.mjs';
import { diffPacks } from '../src/core/pack_diff.mjs';
import { loadPack, projectPack } from '../src/core/pack.mjs';
import { callTool } from '../src/mcp/catalog.mjs';
import { assertContract } from '../src/mcp/contract.mjs';

const ENGINE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const ROOT_COMMIT = 'r'.repeat(40);

function rawPack(type, commit) {
  const graph = new Graph();
  graph.addNode({ id: nodeId('endpoint', 'GET /orders') });
  graph.addNode({ id: nodeId('column', 'orders.total'), type });
  graph.addEdge({ from: 'endpoint:GET /orders', to: 'column:orders.total', type: 'EXECUTES', grade: 'EXACT' });
  return projectPack(graph, { project: 'orders', base: { commit, rootCommit: ROOT_COMMIT, dirty: false } });
}

function withExplicitNull(pack) {
  const copy = JSON.parse(JSON.stringify(pack));
  copy.edges[0].evidence = null;
  copy.digest = digest12({ nodes: copy.nodes, edges: copy.edges });
  return copy;
}

function context(pack, project) {
  return {
    graph: loadPack(pack, { verifyDigest: true }),
    basis: { project, buildDigest: pack.digest, builtAt: null, freshness: { verdict: 'unknown' } },
    trust: {}, limits: [], pack: { ...pack.meta, digest: pack.digest }, packJson: pack,
  };
}

const answerOf = (diff) => {
  const { truncated: _truncated, ...answer } = diff;
  return answer;
};

function mcpAnswers(base, head) {
  const headCtx = context(head, 'head');
  const baseCtx = context(base, 'base');
  headCtx.history = { load: ({ commit }) => (commit === base.meta.base.commit ? { pack: base } : null) };
  const history = callTool('pack_diff', { base_commit: base.meta.base.commit }, headCtx);
  headCtx.federation = { self: 'head', ctxFor: (id) => (id === 'base' ? baseCtx : null) };
  const sibling = callTool('pack_diff', { base: 'base' }, headCtx);
  return { history, sibling };
}

test('MCP history and sibling diffs retain raw absent evidence exactly as core and CLI do', (t) => {
  const base = rawPack('INTEGER', 'a'.repeat(40));
  const head = rawPack('TEXT', 'b'.repeat(40));
  assert.equal(Object.hasOwn(head.edges[0], 'evidence'), false, 'the serialized edge deliberately has no evidence key');
  const expected = diffPacks(base, head);
  assert.equal(expected.edges.changed, 0);
  const { history, sibling } = mcpAnswers(base, head);
  assertContract(history);
  assertContract(sibling);
  assert.deepEqual(history.answer, answerOf(expected));
  assert.deepEqual(sibling.answer, answerOf(expected));
  assert.deepEqual([history.answer.base.digest, history.answer.head.digest], [base.digest, head.digest]);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-mcp-diff-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const write = (name, pack) => {
    const dir = path.join(work, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify(pack));
    return dir;
  };
  const cli = spawnSync(process.execPath, [path.join(ENGINE_ROOT, 'bin', 'cascade.mjs'), 'diff', '--base', write('base', base), '--head', write('head', head), '--json'], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  const { baseNote: _baseNote, ...cliAnswer } = JSON.parse(cli.stdout);
  assert.deepEqual(cliAnswer, expected);
});

test('an intentional explicit-null evidence record remains distinct from an absent record over MCP', () => {
  const base = rawPack('INTEGER', 'a'.repeat(40));
  const head = withExplicitNull(rawPack('TEXT', 'b'.repeat(40)));
  const expected = diffPacks(base, head);
  assert.equal(expected.edges.changed, 1);
  const { history, sibling } = mcpAnswers(base, head);
  assert.deepEqual(history.answer, answerOf(expected));
  assert.deepEqual(sibling.answer, answerOf(expected));
});

test('a stale raw snapshot is refused and graph/meta-only synthetic contexts still compare', () => {
  const base = rawPack('INTEGER', 'a'.repeat(40));
  const head = rawPack('TEXT', 'b'.repeat(40));
  const staleCtx = context(head, 'head');
  staleCtx.packJson = withExplicitNull(base);
  staleCtx.history = { load: () => ({ pack: base }) };
  const stale = callTool('pack_diff', { base_commit: base.meta.base.commit }, staleCtx);
  assert.deepEqual([stale.answer.head.digest, stale.answer.nodes.changed], [head.digest, 1]);
  const synthetic = context(head, 'head');
  delete synthetic.packJson;
  synthetic.history = { load: () => ({ pack: base }) };
  assert.equal(callTool('pack_diff', { base_commit: base.meta.base.commit }, synthetic).answer.nodes.changed, 1);
});
