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
import { Graph, DEFAULT_WALK_DEPTH, WALK_NODE_CAP } from '../src/core/graph.mjs';
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

/** A route whose statement is ten hops below its handler, a column it reads, and a screen that calls the route through two functions. */
function deepGraph() {
  const g = new Graph();
  g.addNode({ id: 'endpoint:GET /deep', path: '/deep', httpMethod: 'GET' });
  const syms = Array.from({ length: 10 }, (_, i) => `symbol:p.S${i}#run`);
  for (const id of syms) g.addNode({ id, file: 'S.java' });
  for (const id of ['statement:p.M.find', 'table:t', 'column:t.c']) g.addNode({ id });
  g.addEdge({ from: 'table:t', to: 'column:t.c', type: 'DECLARES', grade: 'EXACT' });
  g.addEdge({ from: 'endpoint:GET /deep', to: syms[0], type: 'HANDLES', grade: 'EXACT' });
  for (let i = 0; i < syms.length - 1; i++) g.addEdge({ from: syms[i], to: syms[i + 1], type: 'CALLS', grade: 'EXACT' });
  g.addEdge({ from: syms.at(-1), to: 'statement:p.M.find', type: 'IMPLEMENTS_STMT', grade: 'EXACT' });
  g.addEdge({ from: 'statement:p.M.find', to: 'table:t', type: 'EXECUTES', grade: 'EXACT', evidence: { access: 'read' } });
  g.addEdge({ from: 'statement:p.M.find', to: 'column:t.c', type: 'READS', grade: 'EXACT' });
  g.addNode({ id: 'screen:/deep', path: '/deep' });
  g.addNode({ id: 'symbol:web/Deep.vue#setup', file: 'web/Deep.vue', lane: 'web' });
  g.addNode({ id: 'symbol:web/api.ts#load', file: 'web/api.ts', lane: 'web' });
  g.addEdge({ from: 'screen:/deep', to: 'symbol:web/Deep.vue#setup', type: 'RENDERS', grade: 'EXACT' });
  g.addEdge({ from: 'symbol:web/Deep.vue#setup', to: 'symbol:web/api.ts#load', type: 'CALLS', grade: 'EXACT' });
  g.addEdge({ from: 'symbol:web/api.ts#load', to: 'endpoint:GET /deep', type: 'CALLS_HTTP', grade: 'SOUND_SET' });
  return g;
}

test('one_depth_rule_for_one_question: every walk goes as far as the graph goes, the node cap is its guard, and a depth is only a narrowing asked for', () => {
  assert.equal(DEFAULT_WALK_DEPTH, null, 'no hop cap when nobody asks for one');
  assert.equal(WALK_NODE_CAP, 4000);
  const g = deepGraph();
  const ctx = { ...ctxOf(g), pack: { digest: 'd' } };
  // which routes reach t.c: the impact tool, the census row, and Trace up give one answer
  const impact = callTool('endpoint_impact', { column: 't.c' }, ctx).answer.endpoints.map((e) => e.id);
  assert.deepEqual(impact, ['GET /deep']);
  const traceUp = flow(g, { column: 't.c', direction: 'up' }, ctx).answer;
  assert.deepEqual(traceUp.endpoints.map((e) => e.id), impact, 'Trace up reaches the route the impact tool names');
  assert.equal(traceUp.walk.depth, null);
  assert.deepEqual(traceUp.screens.map((x) => x.id), callTool('screen_impact', { column: 't.c' }, ctx).answer.screens.map((x) => x.screen ?? x.id),
    'and the screen screen_impact names, fourteen hops up');
  const browse = callTool('browse', { kind: 'column' }, ctx).answer.items.find((r) => r.column === 't.c');
  assert.equal(browse.endpoints, impact.length, 'the census row counts the same routes');
  // down: the census and Flow reach the statement
  assert.equal(walkEndpoints(g).endpoints[0].statements.length, 1);
  const down = flow(g, { endpoint: 'GET /deep' }, ctxOf(g)).answer;
  assert.deepEqual(down.statements.map((x) => x.id), ['p.M.find']);
  assert.equal(down.walk.depth, null);
  assert.equal(chainWalk(g, { start: 'symbol:p.S0#run' }).depth, null);
  // a depth asked for narrows, and says what it cut
  const narrow = flow(g, { endpoint: 'GET /deep', depth: 4 }, ctxOf(g));
  assert.deepEqual(narrow.answer.statements, []);
  assert.ok(narrow.limits.some((l) => /depth cap 4 reached/.test(l.reason)));
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

/** A statement reached first on a short candidate path, then at the depth cap by a longer EXACT one; one HEURISTIC table beside it. */
function capGraph() {
  const g = new Graph();
  for (const id of ['endpoint:GET /a', 'symbol:p.H#h', 'symbol:p.A#a', 'symbol:p.B#b', 'symbol:p.C#c', 'statement:p.M.s', 'table:t', 'table:g']) g.addNode({ id, ...(id.startsWith('symbol') ? { file: 'X.java' } : {}) });
  g.addEdge({ from: 'endpoint:GET /a', to: 'symbol:p.H#h', type: 'HANDLES', grade: 'EXACT' });
  g.addEdge({ from: 'symbol:p.H#h', to: 'symbol:p.A#a', type: 'CALLS', grade: 'EXACT' });
  g.addEdge({ from: 'symbol:p.A#a', to: 'symbol:p.B#b', type: 'CALLS', grade: 'EXACT' });
  g.addEdge({ from: 'symbol:p.B#b', to: 'statement:p.M.s', type: 'IMPLEMENTS_STMT', grade: 'EXACT' });
  g.addEdge({ from: 'symbol:p.H#h', to: 'symbol:p.C#c', type: 'MAY_CALL', grade: 'SOUND_SET' });
  g.addEdge({ from: 'symbol:p.C#c', to: 'statement:p.M.s', type: 'IMPLEMENTS_STMT', grade: 'EXACT' });
  g.addEdge({ from: 'statement:p.M.s', to: 'table:t', type: 'EXECUTES', grade: 'EXACT', evidence: { access: 'read' } });
  g.addEdge({ from: 'statement:p.M.s', to: 'table:g', type: 'EXECUTES', grade: 'HEURISTIC', evidence: { access: 'read' } });
  return g;
}

test('walk_counts_below_floor_sql_edge_once_when_statement_rereached_at_cap', () => {
  const w = chainWalk(capGraph(), { start: 'symbol:p.H#h', direction: 'down', mode: 'conservative', maxDepth: 3 });
  assert.deepEqual(w.tables.map((t) => t.table), ['t']);
  assert.deepEqual([w.cut.byMode, w.cut.byModeGrades], [1, { HEURISTIC: 1 }], 'the one HEURISTIC EXECUTES, once');
});

test('flow_statement_entry_tables_match_row_in_mode and browse_statement_row_tables_in_census_mode', () => {
  const g = capGraph();
  const ctx = { ...ctxOf(g), pack: { digest: 'd' } };
  const asEntry = flow(g, { statement: 'p.M.s', direction: 'up', mode: 'conservative' }, ctx).answer.entry.tables.map((t) => t.table);
  const asRow = flow(g, { endpoint: 'GET /a', mode: 'conservative' }, ctx).answer.statements.find((x) => x.id === 'p.M.s').tables.map((t) => t.table);
  assert.deepEqual(asEntry, ['t']);
  assert.deepEqual(asEntry, asRow);
  assert.deepEqual(flow(g, { statement: 'p.M.s', direction: 'up', mode: 'heuristic' }, ctx).answer.entry.tables.map((t) => t.table), ['g', 't']);
  const rows = callTool('browse', { kind: 'statement' }, ctx).answer.items;
  assert.equal(rows[0].tables, 1, 'the census mode counts t and not the table only a guess reaches');
});

test('services_count_every_sender_of_a_shared_statement', () => {
  const g = new Graph();
  for (const id of ['endpoint:GET /a', 'symbol:p.C#h', 'symbol:p.DaoA#q', 'symbol:p.DaoB#q', 'statement:ns.sel', 'table:t']) g.addNode({ id, ...(id.startsWith('symbol') ? { file: 'X.java' } : {}) });
  g.addEdge({ from: 'endpoint:GET /a', to: 'symbol:p.C#h', type: 'HANDLES', grade: 'EXACT' });
  g.addEdge({ from: 'symbol:p.C#h', to: 'symbol:p.DaoA#q', type: 'CALLS', grade: 'EXACT' });
  g.addEdge({ from: 'symbol:p.C#h', to: 'symbol:p.DaoB#q', type: 'CALLS', grade: 'EXACT' });
  g.addEdge({ from: 'symbol:p.DaoA#q', to: 'statement:ns.sel', type: 'IMPLEMENTS_STMT', grade: 'EXACT', evidence: { line: 10 } });
  g.addEdge({ from: 'symbol:p.DaoB#q', to: 'statement:ns.sel', type: 'IMPLEMENTS_STMT', grade: 'EXACT', evidence: { line: 20 } });
  g.addEdge({ from: 'statement:ns.sel', to: 'table:t', type: 'EXECUTES', grade: 'EXACT' });
  assert.equal(buildOverview(g).code.services, 2, 'DaoA.q and DaoB.q both send it');
});
