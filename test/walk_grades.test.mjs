// walk_grades.test.mjs — every link on a walked path is a link: the SQL edge that ends it, a route's rejected handler, the default depth, and what a rule is counted for.
//
// Astra's second review found four places where a walk said more than its path
// holds, or less than it skipped: a table reached through a candidate-set
// EXECUTES drawn EXACT and kept in strict; Flow and the census walking to two
// different default depths; a route's handler below the floor not counted when
// another handler was admitted; a node counted twice for one rule. And the
// overview's `services` said 0 for a service that sends its SQL itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Graph, DEFAULT_WALK_DEPTH } from '../src/core/graph.mjs';
import { walkEndpoints } from '../src/core/walks.mjs';
import { chainWalk } from '../src/core/chain.mjs';
import { appliedIndex } from '../src/core/rules/applied.mjs';
import { buildOverview } from '../src/core/overview.mjs';
import { flow } from '../src/mcp/tools.mjs';
import { buildMap } from '../src/core/map.mjs';
import { buildSummary } from '../src/core/summary.mjs';
import { buildCoupling } from '../src/core/coupling.mjs';
import { callTool } from '../src/mcp/catalog.mjs';

const ctxOf = (g) => ({ graph: g, basis: { project: 't', buildDigest: 'd', builtAt: 'x', freshness: { verdict: 'unknown' } }, trust: { trustLevel: 'UNCERTIFIED' }, limits: [] });

/** A route, its handler, a statement that calls a routine, and the two tables the routine may touch (a candidate set) beside one it certainly does. */
function routineGraph() {
  const g = new Graph();
  g.addNode({ id: 'endpoint:GET /r', path: '/r', httpMethod: 'GET' });
  g.addNode({ id: 'symbol:p.C#run', owner: 'p.C', file: 'C.java' });
  g.addNode({ id: 'symbol:p.M#call', owner: 'p.M', file: 'M.java' });
  g.addNode({ id: 'statement:p.M.call', statementType: 'call' });
  for (const t of ['audit', 'orders', 'order_lines']) g.addNode({ id: `table:${t}`, kind: 'table' });
  g.addNode({ id: 'column:orders.id' });
  g.addEdge({ from: 'table:orders', to: 'column:orders.id', type: 'DECLARES', grade: 'EXACT' });
  g.addEdge({ from: 'endpoint:GET /r', to: 'symbol:p.C#run', type: 'HANDLES', grade: 'EXACT' });
  g.addEdge({ from: 'symbol:p.C#run', to: 'symbol:p.M#call', type: 'CALLS', grade: 'EXACT' });
  g.addEdge({ from: 'symbol:p.M#call', to: 'statement:p.M.call', type: 'IMPLEMENTS_STMT', grade: 'EXACT' });
  g.addEdge({ from: 'statement:p.M.call', to: 'table:audit', type: 'EXECUTES', grade: 'EXACT', evidence: { access: 'write' } });
  g.addEdge({ from: 'statement:p.M.call', to: 'table:orders', type: 'EXECUTES', grade: 'SOUND_SET', evidence: { access: 'read' } });
  g.addEdge({ from: 'statement:p.M.call', to: 'table:order_lines', type: 'EXECUTES', grade: 'SOUND_SET', evidence: { access: 'read' } });
  g.addEdge({ from: 'statement:p.M.call', to: 'column:orders.id', type: 'READS', grade: 'SOUND_SET' });
  return g;
}

test('flow_respects_executes_grade_and_mode_for_routine_tables: a table reached through a candidate set is graded by it, and a mode below it does not draw it', () => {
  const g = routineGraph();
  const at = (mode) => flow(g, { endpoint: 'GET /r', mode }, ctxOf(g)).answer;
  const cons = at('conservative');
  assert.deepEqual(cons.tables.map((t) => [t.table, t.grade]), [['audit', 'EXACT'], ['order_lines', 'SOUND_SET'], ['orders', 'SOUND_SET']]);
  assert.equal(cons.tables.find((t) => t.table === 'orders').reads, 1);
  const strict = at('strict');
  assert.deepEqual(strict.tables.map((t) => [t.table, t.grade, t.reads]), [['audit', 'EXACT', 0]], 'strict draws only what an EXACT path reaches');
  assert.match(strict.walk.note, /link\(s\) below the grade floor of mode=strict were not walked/);
  // at the depth cap the BFS never expanded the statement, and the lane still says what it left out
  const capped = chainWalk(g, { start: 'symbol:p.C#run', direction: 'down', mode: 'strict', maxDepth: 2 });
  assert.deepEqual(capped.tables.map((t) => t.table), ['audit']);
  assert.equal(capped.cut.byMode, 3, 'two EXECUTES and one READS below strict, each counted once');
  const walked = chainWalk(g, { start: 'symbol:p.C#run', direction: 'down', mode: 'strict', maxDepth: 6 });
  assert.equal(walked.cut.byMode, 3, 'the same three, counted by the walk that stepped past the statement, not twice');
});

test('Flow and the census walk to one default depth, from one constant', () => {
  assert.equal(DEFAULT_WALK_DEPTH, 8);
  // a statement eight hops below the handler: seven CALLS, then IMPLEMENTS_STMT
  const g = new Graph();
  g.addNode({ id: 'endpoint:GET /deep', path: '/deep', httpMethod: 'GET' });
  const syms = Array.from({ length: 8 }, (_, i) => `symbol:p.S${i}#run`);
  for (const id of syms) g.addNode({ id, file: 'S.java' });
  g.addNode({ id: 'statement:p.M.find', statementType: 'select' });
  g.addEdge({ from: 'endpoint:GET /deep', to: syms[0], type: 'HANDLES', grade: 'EXACT' });
  for (let i = 0; i < 7; i++) g.addEdge({ from: syms[i], to: syms[i + 1], type: 'CALLS', grade: 'EXACT' });
  g.addEdge({ from: syms[7], to: 'statement:p.M.find', type: 'IMPLEMENTS_STMT', grade: 'EXACT' });
  assert.equal(walkEndpoints(g).endpoints[0].statements.length, 1, 'the census reaches it at its default depth');
  const a = flow(g, { endpoint: 'GET /deep' }, ctxOf(g)).answer;
  assert.equal(a.walk.depth, DEFAULT_WALK_DEPTH);
  assert.deepEqual(a.statements.map((s) => s.id), ['p.M.find'], 'and so does Flow, at its own default');
  assert.equal(chainWalk(g, { start: syms[0] }).depth, DEFAULT_WALK_DEPTH, 'and the walk itself');
});

test('walk_counts_rejected_handler_beside_admitted_handler_existing: a route\'s handler below the floor is counted even when another is admitted', () => {
  const g = new Graph();
  for (const id of ['endpoint:GET /x', 'symbol:A', 'symbol:B', 'statement:a', 'statement:b']) g.addNode({ id });
  g.addEdge({ from: 'endpoint:GET /x', to: 'symbol:A', type: 'HANDLES', grade: 'EXACT' });
  g.addEdge({ from: 'endpoint:GET /x', to: 'symbol:B', type: 'HANDLES', grade: 'HEURISTIC' });
  for (const [from, to] of [['symbol:A', 'statement:a'], ['symbol:B', 'statement:b']]) g.addEdge({ from, to, type: 'IMPLEMENTS_STMT', grade: 'EXACT' });
  const w = walkEndpoints(g, { mode: 'conservative' });
  assert.deepEqual([w.walk.byMode, w.walk.byModeGrades], [1, { HEURISTIC: 1 }]);
  // every handler rejected: the route walks from itself, and its links are still counted once
  const g2 = new Graph();
  for (const id of ['endpoint:GET /y', 'symbol:B']) g2.addNode({ id });
  g2.addEdge({ from: 'endpoint:GET /y', to: 'symbol:B', type: 'HANDLES', grade: 'HEURISTIC' });
  const w2 = walkEndpoints(g2, { mode: 'conservative' });
  assert.deepEqual([w2.walk.byMode, w2.walk.byModeGrades], [1, { HEURISTIC: 1 }]);
});

test('rules_count_unique_nodes_per_rule: a node two evidence blocks mark with one rule is one node of that rule', () => {
  const g = new Graph();
  g.addNode({ id: 'statement:s', evidence: { rule: 'prisma.operations' }, prismaEvidence: { rule: 'prisma.operations' } });
  g.addNode({ id: 'statement:t', evidence: { rule: 'a.one' }, prismaEvidence: { rule: 'b.two' } });
  const idx = appliedIndex(g);
  assert.deepEqual(idx.get('prisma.operations').nodes, ['statement:s']);
  assert.deepEqual([idx.get('a.one').nodes, idx.get('b.two').nodes], [['statement:t'], ['statement:t']], 'two rules on one node are one node each');
});

test('the overview counts a service that sends its SQL itself as a service, and a mapper method that only declares a statement as none', () => {
  const g = new Graph();
  const add = (id, attrs = {}) => g.addNode({ id, ...attrs });
  add('endpoint:GET /users', { path: '/users', httpMethod: 'GET' });
  add('symbol:src/c.ts#C.list', { file: 'src/c.ts', lane: 'ts' });
  add('symbol:src/s.ts#UsersService.list', { file: 'src/s.ts', lane: 'ts' });
  add('statement:prisma:src/s.ts#UsersService.list/0', { statementType: 'select' });
  add('table:User');
  g.addEdge({ from: 'endpoint:GET /users', to: 'symbol:src/c.ts#C.list', type: 'HANDLES', grade: 'EXACT' });
  g.addEdge({ from: 'symbol:src/c.ts#C.list', to: 'symbol:src/s.ts#UsersService.list', type: 'MAY_CALL', grade: 'SOUND_SET' });
  g.addEdge({ from: 'symbol:src/s.ts#UsersService.list', to: 'statement:prisma:src/s.ts#UsersService.list/0', type: 'IMPLEMENTS_STMT', grade: 'EXACT', evidence: { rule: 'prisma.client', line: 7 } });
  g.addEdge({ from: 'statement:prisma:src/s.ts#UsersService.list/0', to: 'table:User', type: 'EXECUTES', grade: 'EXACT' });
  // and a Java route through a service to a MyBatis mapper method, which declares its statement and sends nothing
  add('endpoint:GET /orders', { path: '/orders', httpMethod: 'GET' });
  add('symbol:p.OrderController#list', { file: 'O.java' });
  add('symbol:p.OrderService#list', { file: 'OS.java' });
  add('symbol:p.OrderMapper#selectAll', { file: 'OM.java' });
  add('statement:p.OrderMapper.selectAll', { statementType: 'select' });
  g.addEdge({ from: 'endpoint:GET /orders', to: 'symbol:p.OrderController#list', type: 'HANDLES', grade: 'EXACT' });
  g.addEdge({ from: 'symbol:p.OrderController#list', to: 'symbol:p.OrderService#list', type: 'MAY_CALL', grade: 'SOUND_SET' });
  g.addEdge({ from: 'symbol:p.OrderService#list', to: 'symbol:p.OrderMapper#selectAll', type: 'MAY_CALL', grade: 'SOUND_SET' });
  g.addEdge({ from: 'symbol:p.OrderMapper#selectAll', to: 'statement:p.OrderMapper.selectAll', type: 'IMPLEMENTS_STMT', grade: 'EXACT' });
  assert.equal(buildOverview(g).code.services, 2, 'UsersService.list and OrderService.list; not the controllers, not the mapper method');
});

/** The routine graph with a guessed table beside it: `guessed` reached only through a HEURISTIC EXECUTES and READS, and a @Transactional service above it. */
function guessedTableGraph() {
  const g = routineGraph();
  g.addNode({ id: 'table:guessed', kind: 'table' });
  g.addNode({ id: 'column:guessed.name' });
  g.addEdge({ from: 'table:guessed', to: 'column:guessed.name', type: 'DECLARES', grade: 'EXACT' });
  g.addEdge({ from: 'statement:p.M.call', to: 'table:guessed', type: 'EXECUTES', grade: 'HEURISTIC', evidence: { access: 'read' } });
  g.addEdge({ from: 'statement:p.M.call', to: 'column:guessed.name', type: 'READS', grade: 'HEURISTIC' });
  g.nodes.get('symbol:p.C#run').transactional = true;
  return g;
}

test('census_floors_statement_sql_edges: every view counts the tables and columns a walk reaches in its mode as Flow draws them', () => {
  const g = guessedTableGraph();
  const flowTables = (mode) => flow(g, { endpoint: 'GET /r', mode }, ctxOf(g)).answer.tables.map((t) => t.table).sort();
  const census = (mode) => { const r = buildOverview(g, { mode }).reach; return [r.tablesReached, r.columnsReached]; };
  assert.deepEqual(flowTables('strict'), ['audit']);
  assert.deepEqual(census('strict'), [1, 0], 'strict: audit alone, and no column an EXACT edge reads');
  assert.deepEqual(flowTables('conservative'), ['audit', 'order_lines', 'orders']);
  assert.deepEqual(census('conservative'), [3, 1], 'conservative: not the table and column only a guess reaches');
  assert.deepEqual(flowTables('heuristic'), ['audit', 'guessed', 'order_lines', 'orders']);
  assert.deepEqual(census('heuristic'), [4, 2]);
  // the map draws the same tables, in the same mode
  const touched = (mode) => buildMap(g, { mode }).links.filter((l) => l.kind === 'touches').map((l) => l.target).sort();
  assert.deepEqual(touched('conservative'), ['table:audit', 'table:order_lines', 'table:orders']);
  assert.deepEqual(touched('strict'), ['table:audit']);
  // the summary's families and coupling's items too
  const summaryTables = (mode) => buildSummary(g, { mode }).families.flatMap((f) => f.tables).sort();
  assert.ok(!summaryTables('conservative').includes('table:guessed') && summaryTables('heuristic').includes('table:guessed'));
  const couplingItems = (mode) => buildCoupling(g, { mode, axis: 'table' }).summary.items;
  assert.equal(couplingItems('conservative') + 1, couplingItems('heuristic'), 'the guessed table is an item only where its edge is admitted');
  // the browse census and transactions answer at conservative, their fixed mode
  const ctx = { ...ctxOf(g), pack: { digest: 'd' } };
  const browse = callTool('browse', { kind: 'table' }, ctx).answer.items;
  assert.deepEqual(Object.fromEntries(browse.map((r) => [r.table, r.endpoints])), { audit: 1, guessed: 0, order_lines: 1, orders: 1 });
  const tx = callTool('transactions', { method: 'p.C#run' }, ctx).answer;
  const txRow = tx.boundaries?.[0] ?? tx.items?.[0] ?? tx;
  assert.ok(!JSON.stringify(txRow).includes('guessed'), 'a transaction does not touch a table only a guess reaches');
  // the statement row in Flow lists only the tables its mode admits
  const stRow = flow(g, { endpoint: 'GET /r', mode: 'strict' }, ctxOf(g)).answer.statements[0];
  assert.deepEqual(stRow.tables.map((t) => t.table), ['audit']);
});
