// diff_report_cli.test.mjs — the CLI makes semantic pack changes reviewable.

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

function basePack() {
  const graph = new Graph();
  const endpoint = nodeId('endpoint', 'GET /orders');
  const handler = nodeId('symbol', 'orders.Controller#list');
  const statement = nodeId('statement', 'orders.Mapper#list');
  const table = nodeId('table', 'orders');
  const status = nodeId('column', 'orders.status');
  graph.addNode({ id: endpoint, path: '/orders', httpMethod: 'GET' });
  graph.addNode({ id: handler, owner: 'orders.Controller' });
  graph.addNode({ id: statement, statementType: 'select' });
  graph.addNode({ id: table });
  graph.addNode({ id: status, type: 'varchar(32)', nullable: null, file: 'schema-v1.sql', line: 2 });
  graph.addNode({ id: nodeId('column', 'orders.kind'), type: 'varchar(8)' });
  graph.addNode({ id: nodeId('column', 'orders.legacy'), type: 'varchar(8)', file: 'schema-v1.sql', line: 9 });
  graph.addEdge({ from: endpoint, to: handler, type: 'HANDLES', grade: 'EXACT' });
  graph.addEdge({ from: handler, to: statement, type: 'CALLS', grade: 'EXACT' });
  graph.addEdge({ from: statement, to: status, type: 'READS', grade: 'EXACT', evidence: { rule: 'sql', access: 'read' } });
  graph.addEdge({ from: statement, to: status, type: 'READS', grade: 'EXACT', evidence: { rule: 'sql', access: 'read', replica: 'two' } });
  graph.addEdge({ from: table, to: nodeId('column', 'orders.legacy'), type: 'DECLARES', grade: 'EXACT', evidence: { rule: 'catalog', origin: { file: 'schema-v1.sql', line: 9 } } });
  return projectPack(graph, { project: 'orders', base: { rootCommit: 'a'.repeat(40), commit: 'a'.repeat(40) } });
}

function changedPack(base) {
  const head = JSON.parse(JSON.stringify(base));
  const node = (id) => head.nodes.find((row) => row.id === id);
  node(nodeId('column', 'orders.status')).type = 'integer';
  delete node(nodeId('column', 'orders.status')).nullable;
  node(nodeId('column', 'orders.kind')).type = 'char(8)';
  node(nodeId('column', 'orders.legacy')).file = 'schema-v2.sql';
  node(nodeId('column', 'orders.legacy')).line = 11;
  for (const edge of head.edges.filter((row) => row.type === 'READS')) edge.evidence.access = 'write';
  const declared = head.edges.find((row) => row.type === 'DECLARES');
  declared.evidence.origin = { file: 'schema-v2.sql', line: 11 };
  head.meta.base.commit = 'b'.repeat(40);
  head.digest = digest12({ nodes: head.nodes, edges: head.edges });
  return head;
}

test('cascade diff prints and serializes semantic record changes separately from moves', (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-diff-report-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const write = (name, pack) => {
    const dir = path.join(work, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify(pack));
    return dir;
  };
  const run = (base, head, ...args) => spawnSync(process.execPath, [CLI, 'diff', '--base', base, '--head', head, ...args], {
    encoding: 'utf8', maxBuffer: 1 << 26,
    env: { ...process.env, CASCADE_HOME: path.join(work, 'home'), XDG_CACHE_HOME: path.join(work, 'cache') },
  });
  const base = write('base', basePack());
  const head = write('head', changedPack(JSON.parse(fs.readFileSync(path.join(base, 'pack.json'), 'utf8'))));

  const text = run(base, head);
  assert.equal(text.status, 0, text.stderr);
  assert.ok(text.stdout.indexOf('conditions:') < text.stdout.indexOf('nodes:'), text.stdout);
  assert.match(text.stdout, /^nodes: \+0 -0 changed 2 moved 1 {2}\(column changed 2\/moved 1\)$/m);
  assert.match(text.stdout, /^edges: \+0 -0 regraded 0 changed 1 moved 1 {2}\(DECLARES moved 1, READS changed 1\)$/m);
  assert.match(text.stdout, /changed nodes \(shown 2 of 2\)\n {2}column:orders\.kind\n {4}type: "varchar\(8\)" -> "char\(8\)"/);
  assert.match(text.stdout, /column:orders\.status\n {4}nullable: null -> <missing>\n {4}type: "varchar\(32\)" -> "integer"/);
  assert.match(text.stdout, /moved nodes \(location only\) \(shown 1 of 1\)\n {2}column:orders\.legacy\n {4}file: "schema-v1\.sql" -> "schema-v2\.sql"/);
  assert.match(text.stdout, /changed edges \(content\/evidence\) \(shown 1 of 1\)/);
  assert.match(text.stdout, /base records: \[\{"grade":"EXACT","evidence":\{"access":"read","replica":"two","rule":"sql"\}\},\{"grade":"EXACT","evidence":\{"access":"read","rule":"sql"\}\}\]/);
  assert.match(text.stdout, /evidence\.access: \[\{"grade":"EXACT","present":true,"value":"read"\},\{"grade":"EXACT","present":true,"value":"read"\}\] -> \[\{"grade":"EXACT","present":true,"value":"write"\},\{"grade":"EXACT","present":true,"value":"write"\}\]/);
  assert.match(text.stdout, /moved edges \(location only\) \(shown 1 of 1\)[\s\S]*evidence\.origin: \{"file":"schema-v1\.sql","line":9\} -> \{"file":"schema-v2\.sql","line":11\}/);
  assert.match(text.stdout, /^endpoints above the change: 1\n {2}GET \/orders$/m);

  const cut = run(base, head, '--limit', '1');
  assert.equal(cut.status, 0, cut.stderr);
  assert.match(cut.stdout, /changed nodes \(shown 1 of 2\)/);
  assert.match(cut.stdout, /cut: nodes\.changed 1 of 2 \(raise --limit, or --json\)/);

  const json = run(base, head, '--json', '--limit', '1');
  assert.equal(json.status, 0, json.stderr);
  const report = JSON.parse(json.stdout);
  assert.deepEqual([report.nodes.changed, report.nodes.moved, report.edges.changed, report.edges.moved], [2, 1, 1, 1]);
  assert.equal(report.nodes.changedList.length, 1);
  assert.deepEqual(report.truncated.fields.find((field) => field.field === 'nodes.changed'), {
    field: 'nodes.changed', shown: 1, total: 2, order: 'kind, id asc', nextOffset: 1,
  });
});
