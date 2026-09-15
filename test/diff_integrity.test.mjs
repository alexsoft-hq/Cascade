// diff_integrity.test.mjs — `cascade diff` only compares packs it can verify.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Graph, nodeId } from '../src/core/graph.mjs';
import { digest12 } from '../src/core/canonical.mjs';
import { projectPack } from '../src/core/pack.mjs';

const ENGINE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const CLI = path.join(ENGINE_ROOT, 'bin', 'cascade.mjs');

function pack({ head = false } = {}) {
  const graph = new Graph();
  const endpoint = nodeId('endpoint', 'GET /orders');
  const handler = nodeId('symbol', 'orders.Controller#list');
  graph.addNode({ id: endpoint, path: '/orders', httpMethod: 'GET' });
  graph.addNode({ id: handler, owner: 'orders.Controller' });
  graph.addEdge({ from: endpoint, to: handler, type: 'HANDLES', grade: 'EXACT' });
  if (head) graph.addNode({ id: nodeId('table', 'orders') });
  return projectPack(graph, {
    project: 'orders',
    base: { rootCommit: 'a'.repeat(40), commit: head ? 'b'.repeat(40) : 'a'.repeat(40) },
  });
}

const copy = (value) => JSON.parse(JSON.stringify(value));

test('cascade diff refuses invalid base and head packs before it prints a comparison', (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-diff-integrity-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const write = (name, value) => {
    const dir = path.join(work, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify(value));
    return dir;
  };
  const run = (base, head) => spawnSync(process.execPath, [CLI, 'diff', '--base', base, '--head', head], {
    encoding: 'utf8', maxBuffer: 1 << 26,
    env: { ...process.env, CASCADE_HOME: path.join(work, 'home'), XDG_CACHE_HOME: path.join(work, 'cache') },
  });
  const base = pack();
  const head = pack({ head: true });
  const goodBase = write('good-base', base);
  const goodHead = write('good-head', head);

  const good = run(goodBase, goodHead);
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /nodes: \+1 -0/);

  const changedNode = copy(base);
  changedNode.nodes[0].id = nodeId('endpoint', 'GET /tampered');
  const badBase = write('bad-base', changedNode);
  const baseRejected = run(badBase, goodHead);
  assert.equal(baseRejected.status, 2);
  assert.equal(baseRejected.stdout, '');
  assert.match(baseRejected.stderr, new RegExp(`invalid base pack at ${escape(path.join(badBase, 'pack.json'))}: pack digest mismatch`));

  const changedEdge = copy(head);
  changedEdge.edges[0].grade = 'HEURISTIC';
  const badHead = write('bad-head', changedEdge);
  const headRejected = run(goodBase, badHead);
  assert.equal(headRejected.status, 2);
  assert.equal(headRejected.stdout, '');
  assert.match(headRejected.stderr, new RegExp(`invalid head pack at ${escape(path.join(badHead, 'pack.json'))}: pack digest mismatch`));

  const wrongSchema = copy(head);
  wrongSchema.schema = 'cascade:pack:999';
  const badSchema = write('bad-schema', wrongSchema);
  const schemaRejected = run(goodBase, badSchema);
  assert.equal(schemaRejected.status, 2);
  assert.equal(schemaRejected.stdout, '');
  assert.match(schemaRejected.stderr, /invalid head pack at .*unknown pack schema/);

  const missingArrays = copy(base);
  delete missingArrays.edges;
  const missingEdges = write('missing-edges', missingArrays);
  const arraysRejected = run(missingEdges, goodHead);
  assert.equal(arraysRejected.status, 2);
  assert.equal(arraysRejected.stdout, '');
  assert.match(arraysRejected.stderr, /invalid base pack at .*pack\.nodes and pack\.edges must be arrays/);

  const malformedGraph = copy(head);
  malformedGraph.edges[0].type = 'NOT_AN_EDGE';
  malformedGraph.digest = digest12({ nodes: malformedGraph.nodes, edges: malformedGraph.edges });
  const badGraph = write('bad-graph', malformedGraph);
  const graphRejected = run(goodBase, badGraph);
  assert.equal(graphRejected.status, 2);
  assert.equal(graphRejected.stdout, '');
  assert.match(graphRejected.stderr, /invalid head pack at .*unknown edge type: "NOT_AN_EDGE"/);
});

function escape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
