import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodeId, buildGraph, Graph, FLOW_EDGE_TYPES } from '../src/core/graph.mjs';
import { buildGraphFromSql } from '../src/adapters/sql_bridge.mjs';
import { addJavaFacts } from '../src/adapters/java_bridge.mjs';
import { chainWalk, nodeLabel, weakestOf, ChainError } from '../src/core/chain.mjs';

// ---------------------------------------------------------------------------
// Fixture (catalog/lineage/javaFacts style of test/transactions.test.mjs):
//
//   endpoint GET /p/{id} --HANDLES--> com.x.PController#get      (the walk starts here)
//     #get --MAY_CALL--> com.x.PService#load        (interface)
//                    --> com.ext.Ext#send           (external: the lane saw no file)
//     PService#load --MAY_CALL(dispatch)--> com.x.PServiceImpl#load   (@Transactional)
//     PServiceImpl#load --MAY_CALL--> com.x.PMapper#selectByPrimaryKey   ┐ the fork:
//                                --> com.x.PMapper#updateByPrimaryKey    ┘ two branches
//     each mapper method --IMPLEMENTS_STMT--> its statement --EXECUTES--> table p / q
// ---------------------------------------------------------------------------

function catalog() {
  return [
    { kind: 'table', schema: null, table: 'p', comment: 'product' },
    { kind: 'column', schema: null, table: 'p', column: 'id', type: 'INT', comment: 'pk', pk: true },
    { kind: 'column', schema: null, table: 'p', column: 'name', type: 'VARCHAR', comment: null },
    { kind: 'column', schema: null, table: 'p', column: 'price', type: 'DECIMAL', comment: null },
    { kind: 'table', schema: null, table: 'q', comment: 'product relation' },
    { kind: 'column', schema: null, table: 'q', column: 'id', type: 'INT', comment: null, pk: true },
    { kind: 'column', schema: null, table: 'q', column: 'p_id', type: 'INT', comment: null },
    // z is touched by NO statement — only a JOINS edge points at it (see flowGraph)
    { kind: 'table', schema: null, table: 'z', comment: 'joined only' },
    { kind: 'column', schema: null, table: 'z', column: 'k', type: 'INT', comment: null },
  ];
}

function lineage() {
  return [
    {
      kind: 'lineage', namespace: 'com.x.PMapper', id: 'selectByPrimaryKey', type: 'select',
      tables: [{ table: 'p', access: 'read' }],
      columns: [{ table: 'p', column: 'id', access: 'read' }, { table: 'p', column: 'name', access: 'read' }],
      file: 'PMapper.xml', line: 10,
    },
    {
      kind: 'lineage', namespace: 'com.x.PMapper', id: 'updateByPrimaryKey', type: 'update',
      tables: [{ table: 'p', access: 'write' }, { table: 'q', access: 'write' }],
      columns: [
        { table: 'p', column: 'name', access: 'write' },
        { table: 'p', column: 'price', access: 'write' },
        { table: 'p', column: 'id', access: 'read' },
        { table: 'q', column: 'p_id', access: 'write' },
      ],
      file: 'PMapper.xml', line: 30,
    },
  ];
}

function javaFacts() {
  return [
    { kind: 'type', fqn: 'com.x.PController', typeKind: 'class', package: 'com.x', file: 'src/PController.java', implements: [] },
    { kind: 'type', fqn: 'com.x.PService', typeKind: 'interface', package: 'com.x', file: 'src/PService.java', implements: [] },
    { kind: 'type', fqn: 'com.x.PServiceImpl', typeKind: 'class', package: 'com.x', file: 'src/PServiceImpl.java', implements: ['PService'] },
    { kind: 'type', fqn: 'com.x.PMapper', typeKind: 'interface', package: 'com.x', file: 'src/PMapper.java', implements: [] },
    // No `file`: a type the lane never saw → its symbols are external.
    { kind: 'type', fqn: 'com.ext.Ext', typeKind: 'class', package: 'com.ext', implements: [] },
    { kind: 'import', owner: 'com.x.PController', simple: 'Ext', fqn: 'com.ext.Ext' },
    { kind: 'method', fqn: 'com.x.PController#get', owner: 'com.x.PController', paramCount: 1, line: 30 },
    { kind: 'method', fqn: 'com.x.PService#load', owner: 'com.x.PService', paramCount: 1, line: 5 },
    { kind: 'method', fqn: 'com.x.PServiceImpl#load', owner: 'com.x.PServiceImpl', paramCount: 1, line: 20 },
    { kind: 'method', fqn: 'com.x.PMapper#selectByPrimaryKey', owner: 'com.x.PMapper', paramCount: 1, line: 7 },
    { kind: 'method', fqn: 'com.x.PMapper#updateByPrimaryKey', owner: 'com.x.PMapper', paramCount: 1, line: 12 },
    { kind: 'call', from: 'com.x.PController#get', receiver: 's', method: 'load', toTypeSimple: 'PService' },
    { kind: 'call', from: 'com.x.PController#get', receiver: 'e', method: 'send', toTypeSimple: 'Ext' },
    { kind: 'call', from: 'com.x.PServiceImpl#load', receiver: 'm', method: 'selectByPrimaryKey', toTypeSimple: 'PMapper' },
    { kind: 'call', from: 'com.x.PServiceImpl#load', receiver: 'm', method: 'updateByPrimaryKey', toTypeSimple: 'PMapper' },
    { kind: 'endpoint', httpMethod: 'GET', path: '/p/{id}', handler: 'com.x.PController#get', line: 30 },
    { kind: 'transactional', method: 'com.x.PServiceImpl#load', scope: 'method', line: 20 },
  ];
}

function flowGraph() {
  const g = buildGraphFromSql(catalog(), lineage());
  addJavaFacts(g, javaFacts());
  // A schema relation, not an execution step: p JOINS z. The walk must not
  // travel it (nor DECLARES), or every joined table's columns would land in
  // the answer as if the request had touched them.
  g.addEdge({ from: nodeId('table', 'p'), to: nodeId('table', 'z'), type: 'JOINS', grade: 'EXACT', evidence: { columns: ['id=k'], count: 1 } });
  return g;
}

const HANDLER = nodeId('symbol', 'com.x.PController#get');
const IMPL = nodeId('symbol', 'com.x.PServiceImpl#load');
const MAPPER_SELECT = nodeId('symbol', 'com.x.PMapper#selectByPrimaryKey');
const SELECT_STMT = 'com.x.PMapper.selectByPrimaryKey';
const UPDATE_STMT = 'com.x.PMapper.updateByPrimaryKey';

const walk = (over = {}) => chainWalk(flowGraph(), { start: HANDLER, ...over });

// ---------------------------------------------------------------------------
// the shape of the walk
// ---------------------------------------------------------------------------

test('chainWalk: hops per column — services at 1-2, statements at 4, tables at 5', () => {
  const w = walk();
  assert.deepEqual(w.services.map((s) => [s.short, s.hops]), [
    ['Ext#send', 1], ['PService#load', 1], ['PServiceImpl#load', 2],
  ]);
  assert.deepEqual(w.statements.map((s) => [s.id, s.hops]), [[SELECT_STMT, 4], [UPDATE_STMT, 4]]);
  assert.deepEqual(w.tables.map((t) => [t.table, t.hops]), [['p', 5], ['q', 5]]);
  // 5 symbols + 2 statements + 2 tables + 4 columns, start excluded. Only the
  // columns the reached statements actually read/write — a table's DECLARES
  // edges are schema, not execution, so q.id (nobody touches it) is not walked.
  assert.equal(w.walked, 13);
  assert.equal(w.depth, 6);
  assert.equal(w.mode, 'conservative');
});

test('chainWalk: mapper methods are never listed as services (they are the statement column)', () => {
  const w = walk();
  const ids = w.services.map((s) => s.id);
  assert.equal(ids.includes('com.x.PMapper#selectByPrimaryKey'), false);
  assert.equal(ids.includes('com.x.PMapper#updateByPrimaryKey'), false);
  assert.equal(w.statements.find((s) => s.id === SELECT_STMT).symbol, 'com.x.PMapper#selectByPrimaryKey');
});

test('chainWalk: an external symbol (no file) and a @Transactional impl are flagged', () => {
  const w = walk();
  const ext = w.services.find((s) => s.id === 'com.ext.Ext#send');
  assert.equal(ext.external, true);
  assert.equal(ext.file, null);
  const impl = w.services.find((s) => s.id === 'com.x.PServiceImpl#load');
  assert.equal(impl.external, false);
  assert.equal(impl.transactional, true);
  assert.equal(impl.file, 'src/PServiceImpl.java');
  assert.equal(impl.line, 20);
  assert.equal(impl.owner, 'com.x.PServiceImpl');
});

// ---------------------------------------------------------------------------
// weakest link + path reconstruction
// ---------------------------------------------------------------------------

test('chainWalk: a row grade is the WEAKEST link on its path, not its last edge', () => {
  const w = walk();
  const st = w.statements.find((s) => s.id === SELECT_STMT);
  // The last edge into the statement is IMPLEMENTS_STMT/EXACT — still on the
  // path — but the call chain that got there is SOUND_SET → a candidate row.
  assert.equal(st.path[st.path.length - 1].type, 'IMPLEMENTS_STMT');
  assert.equal(st.path[st.path.length - 1].grade, 'EXACT');
  assert.equal(st.grade, 'SOUND_SET');
  assert.equal(w.tables.find((t) => t.table === 'p').grade, 'SOUND_SET');
  assert.equal(weakestOf(st.path), 'SOUND_SET');
});

test('chainWalk: from the mapper method itself every link is EXACT → EXACT rows', () => {
  const w = chainWalk(flowGraph(), { start: MAPPER_SELECT });
  const st = w.statements.find((s) => s.id === SELECT_STMT);
  assert.equal(st.hops, 1);
  assert.equal(st.grade, 'EXACT');
  // nothing to fold here: the walk began AT the mapper, so the link is its own edge
  assert.equal(st.link.from, MAPPER_SELECT);
  assert.equal(st.link.type, 'IMPLEMENTS_STMT');
  assert.equal(st.path.length, 1);
  assert.deepEqual(w.tables.map((t) => [t.table, t.hops, t.grade]), [['p', 2, 'EXACT']]);
  assert.deepEqual(w.byLinkGrade, { EXACT: 2, SOUND_SET: 0, HEURISTIC: 0 }); // the statement + table p (columns excluded)
});

test('chainWalk: path reconstructs the walked edges from start to the row', () => {
  const w = walk();
  const st = w.statements.find((s) => s.id === UPDATE_STMT);
  assert.deepEqual(st.path.map((e) => e.type), ['MAY_CALL', 'MAY_CALL', 'MAY_CALL', 'IMPLEMENTS_STMT']);
  assert.equal(st.path[0].from, HANDLER);
  assert.equal(st.path[st.path.length - 1].to, nodeId('statement', UPDATE_STMT));
  // every hop chains: to === next.from
  for (let i = 1; i < st.path.length; i++) assert.equal(st.path[i].from, st.path[i - 1].to);
  // the dispatch edge carries its evidence (what the page shows for a candidate)
  const dispatch = w.services.find((s) => s.id === 'com.x.PServiceImpl#load').link;
  assert.equal(dispatch.iface, 'com.x.PService');
  assert.equal(dispatch.from, nodeId('symbol', 'com.x.PService#load'));
  assert.equal(dispatch.fromShort, 'PService#load');
  assert.ok(dispatch.basis.includes('dispatch'));
});

test('chainWalk: the statement row links to the SERVICE that called its mapper (the mapper is folded in)', () => {
  const w = walk();
  const st = w.statements.find((s) => s.id === SELECT_STMT);
  // draw link = the call INTO the mapper, so the statement column hangs off a
  // row the view actually renders…
  assert.equal(st.link.from, nodeId('symbol', 'com.x.PServiceImpl#load'));
  assert.equal(st.link.type, 'MAY_CALL');
  assert.equal(st.link.grade, 'SOUND_SET');
  // …while the folded mapper method is still named, and still on the path
  assert.equal(st.symbol, 'com.x.PMapper#selectByPrimaryKey');
  assert.equal(st.path.length, 4);
  assert.equal(st.path[st.path.length - 1].from, nodeId('symbol', 'com.x.PMapper#selectByPrimaryKey'));
  // the mapper is never a service row, so nothing else could have drawn it
  assert.equal(w.services.some((s) => s.id === 'com.x.PMapper#selectByPrimaryKey'), false);
});

// ---------------------------------------------------------------------------
// which edges are execution, and which are only schema
// ---------------------------------------------------------------------------

test('chainWalk: JOINS and DECLARES are schema, not execution — never walked, never counted', () => {
  const w = walk();
  assert.equal(w.tables.some((t) => t.table === 'z'), false, 'a JOINS-only table is not in the chain');
  assert.equal(w.walked, 13);      // z and its column are not walked
  assert.equal(w.cut.depth, 0);    // …so no false "there is more beyond the cap"
  assert.equal(w.cut.byMode, 0);   // an out-of-scope type is NOT "skipped by the mode"
  // opting back in proves the edges are really there — and what they would cost
  const wide = chainWalk(flowGraph(), { start: HANDLER, edgeTypes: [...FLOW_EDGE_TYPES, 'JOINS', 'DECLARES'] });
  assert.equal(wide.walked, 15);  // + table z and column z.k, which this call never touches
  assert.ok(wide.walked > w.walked, 'following schema edges reaches nodes the request does not run through');
  assert.equal(wide.tables.some((t) => t.table === 'z'), false, 'and still no statement executes z');
});

test('chainWalk: cut.depth counts unfollowed CALLS only — a statement at the cap hides nothing', () => {
  // hop 4 is where the statements sit: they are the boundary, and their tables
  // come from their own edges, so nothing is missing and nothing is claimed.
  const atStatements = walk({ maxDepth: 4 });
  assert.deepEqual(atStatements.statements.map((s) => s.hops), [4, 4]);
  assert.deepEqual(atStatements.tables.map((t) => t.table), ['p', 'q']); // still fully there
  assert.equal(atStatements.cut.depth, 0, 'a statement boundary is complete by construction');
  // one hop earlier the boundary is the mapper METHODS — real calls not followed
  const atMappers = walk({ maxDepth: 3 });
  assert.equal(atMappers.statements.length, 0);
  assert.equal(atMappers.cut.depth, 2);
});

// ---------------------------------------------------------------------------
// tables: via / access / distinct column counts
// ---------------------------------------------------------------------------

test('chainWalk: tables aggregate the reached statements — via, access, distinct r/w columns', () => {
  const w = walk();
  const p = w.tables.find((t) => t.table === 'p');
  assert.equal(p.statements, 2);
  assert.equal(p.access, 'read+write');
  assert.equal(p.reads, 2);  // p.id, p.name (p.id read by both statements counts once)
  assert.equal(p.writes, 2); // p.name, p.price
  assert.equal(p.comment, 'product');
  // tie on grade and hops → the id-ascending statement represents the table
  assert.equal(p.via, SELECT_STMT);
  assert.equal(p.viaShort, 'PMapper.selectByPrimaryKey');
  const q = w.tables.find((t) => t.table === 'q');
  assert.equal(q.statements, 1);
  assert.equal(q.access, 'write');
  assert.equal(q.reads, 0);
  assert.equal(q.writes, 1);
  assert.equal(q.via, UPDATE_STMT);
  // the statement row lists the same tables with their access
  assert.deepEqual(w.statements.find((s) => s.id === UPDATE_STMT).tables,
    [{ table: 'p', access: 'write' }, { table: 'q', access: 'write' }]);
});

// ---------------------------------------------------------------------------
// what the walk did NOT look at
// ---------------------------------------------------------------------------

test('chainWalk: strict reaches nothing here and says why — cut.byMode counts the skipped links', () => {
  const w = walk({ mode: 'strict' });
  assert.equal(w.services.length, 0);
  assert.equal(w.statements.length, 0);
  assert.equal(w.tables.length, 0);
  assert.equal(w.walked, 0);
  assert.equal(w.cut.byMode, 2); // both MAY_CALL edges out of the handler
  assert.equal(w.cut.depth, 0);
});

test('chainWalk: cut.depth counts nodes still expanding at the depth cap', () => {
  const w = walk({ maxDepth: 2 });
  assert.equal(w.statements.length, 0);
  assert.equal(w.tables.length, 0);
  assert.equal(w.services.length, 3);
  // PServiceImpl#load sits at hop 2 with two unwalked mapper calls beyond it
  assert.equal(w.cut.depth, 1);
  assert.equal(chainWalk(flowGraph(), { start: HANDLER, maxDepth: 6 }).cut.depth, 0);
});

test('chainWalk: a tiny maxNodes trips cut.nodeCap and stops the walk growing', () => {
  const w = walk({ maxNodes: 2 });
  assert.equal(w.cut.nodeCap, true);
  assert.equal(w.walked, 2);
  assert.equal(chainWalk(flowGraph(), { start: HANDLER, maxNodes: 4000 }).cut.nodeCap, false);
});

test('chainWalk: byLinkGrade counts the via edge of every reached non-column node', () => {
  const w = walk();
  // 5 symbols + 2 statements + 2 tables = 9 non-column nodes; only the two
  // IMPLEMENTS_STMT and the two EXECUTES edges are EXACT.
  assert.deepEqual(w.byLinkGrade, { EXACT: 4, SOUND_SET: 5, HEURISTIC: 0 });
});

// ---------------------------------------------------------------------------
// layers — the same walk folded per hop
// ---------------------------------------------------------------------------

test('chainWalk: layers are one row per hop 1..depth-reached, counting the SAME nodes byLinkGrade counts', () => {
  const w = walk();
  assert.deepEqual(w.layers, [
    { hops: 1, nodes: 2, services: 2, statements: 0, tables: 0, byLinkGrade: { EXACT: 0, SOUND_SET: 2, HEURISTIC: 0 } },
    { hops: 2, nodes: 1, services: 1, statements: 0, tables: 0, byLinkGrade: { EXACT: 0, SOUND_SET: 1, HEURISTIC: 0 } },
    // hop 3 is the two mapper METHODS: nodes, but no lane row (they are folded
    // into the statement rows one hop below).
    { hops: 3, nodes: 2, services: 0, statements: 0, tables: 0, byLinkGrade: { EXACT: 0, SOUND_SET: 2, HEURISTIC: 0 } },
    { hops: 4, nodes: 2, services: 0, statements: 2, tables: 0, byLinkGrade: { EXACT: 2, SOUND_SET: 0, HEURISTIC: 0 } },
    { hops: 5, nodes: 2, services: 0, statements: 0, tables: 2, byLinkGrade: { EXACT: 2, SOUND_SET: 0, HEURISTIC: 0 } },
  ]);
  assert.deepEqual(w.beyond, { tables: 0 }); // depth 6 stepped onto every table
});

test('chainWalk: the layer sums reconcile with the walk-level counts', () => {
  const w = walk();
  const sum = (k) => w.layers.reduce((n, l) => n + l[k], 0);
  // walked counts columns too; the layers deliberately do not (neither does
  // byLinkGrade), so the difference is exactly the 4 reached columns.
  assert.equal(sum('nodes'), 9);
  assert.equal(w.walked - sum('nodes'), 4);
  for (const g of ['EXACT', 'SOUND_SET', 'HEURISTIC']) {
    assert.equal(w.layers.reduce((n, l) => n + l.byLinkGrade[g], 0), w.byLinkGrade[g], `byLinkGrade.${g} must be the sum over layers`);
  }
  // …and each lane count is that lane's hop histogram
  for (const lane of ['services', 'statements', 'tables']) {
    assert.deepEqual(w.layers.map((l) => l[lane]),
      w.layers.map((l) => w[lane].filter((r) => r.hops === l.hops).length), lane);
  }
});

test('chainWalk: layers cover WALKED nodes only — a table derived past the cap lands in beyond', () => {
  // depth 4 reaches the statements but never steps onto their tables: the table
  // rows are still complete (they come from the statements' own edges), so they
  // are counted apart instead of inventing a hop-5 layer nobody walked.
  const w = walk({ maxDepth: 4 });
  assert.deepEqual(w.tables.map((t) => [t.table, t.hops]), [['p', 5], ['q', 5]]);
  assert.deepEqual(w.layers.map((l) => l.hops), [1, 2, 3, 4]);
  assert.equal(w.layers.every((l) => l.tables === 0), true);
  assert.deepEqual(w.beyond, { tables: 2 });
  // the census still adds up: nodes == non-column reached, columns excluded
  assert.equal(w.layers.reduce((n, l) => n + l.nodes, 0), 7); // 5 symbols + 2 statements
});

test('chainWalk: a walk that reaches nothing has no layers at all (hop 0 is the start, not a layer)', () => {
  const w = walk({ mode: 'strict' });
  assert.deepEqual(w.layers, []);
  assert.deepEqual(w.beyond, { tables: 0 });
});

// ---------------------------------------------------------------------------
// determinism + errors
// ---------------------------------------------------------------------------

test('chainWalk: two runs over the same facts are deep-equal (deterministic)', () => {
  assert.deepEqual(walk(), walk());
  assert.deepEqual(walk({ maxDepth: 3 }), walk({ maxDepth: 3 }));
});

test('chainWalk: an unknown start node throws ChainError', () => {
  assert.throws(() => chainWalk(flowGraph(), { start: nodeId('symbol', 'nope#nope') }),
    (e) => e instanceof ChainError && /start node not in graph/.test(e.message));
});

test('chainWalk: an unknown mode throws ChainError', () => {
  assert.throws(() => chainWalk(flowGraph(), { start: HANDLER, mode: 'lax' }),
    (e) => e instanceof ChainError && /unknown mode/.test(e.message));
});

test('nodeLabel: one naming rule for symbols, statements, columns and endpoints', () => {
  const g = flowGraph();
  assert.equal(nodeLabel(g.nodes.get(IMPL), IMPL), 'PServiceImpl#load');
  assert.equal(nodeLabel(g.nodes.get(nodeId('statement', SELECT_STMT)), nodeId('statement', SELECT_STMT)), 'PMapper.selectByPrimaryKey');
  assert.equal(nodeLabel(g.nodes.get(nodeId('endpoint', 'GET /p/{id}')), nodeId('endpoint', 'GET /p/{id}')), 'GET /p/{id}');
  assert.equal(nodeLabel(g.nodes.get(nodeId('column', 'p.name')), nodeId('column', 'p.name')), 'p.name');
  assert.equal(nodeLabel(null, nodeId('table', 'p')), 'p'); // works without the node
});

// ---------------------------------------------------------------------------
// the record a row reports is the path that was actually walked
//
//   S --MAY_CALL/SOUND_SET--> Y --CALLS/EXACT--> X
//   S --CALLS--> A --CALLS--> B --CALLS--> Y        (all EXACT, all longer)
//
// At depth 3 the walk reaches X in 2 hops through the SOUND_SET edge; only
// later does B hand Y a stronger (EXACT) record at 3 hops. X's own record must
// keep the path that produced it — 2 edges, SOUND_SET — not inherit Y's newer,
// longer, stronger one.
// ---------------------------------------------------------------------------

function upgradeGraph() {
  const S = nodeId('symbol', 'S'), Y = nodeId('symbol', 'Y'), X = nodeId('symbol', 'X');
  const A = nodeId('symbol', 'A'), B = nodeId('symbol', 'B');
  const g = buildGraph([
    { fact: 'edge', from: S, to: Y, type: 'MAY_CALL', grade: 'SOUND_SET' },
    { fact: 'edge', from: Y, to: X, type: 'CALLS', grade: 'EXACT' },
    { fact: 'edge', from: S, to: A, type: 'CALLS', grade: 'EXACT' },
    { fact: 'edge', from: A, to: B, type: 'CALLS', grade: 'EXACT' },
    { fact: 'edge', from: B, to: Y, type: 'CALLS', grade: 'EXACT' },
  ]);
  return { g, S, Y, X, A, B };
}

test('chainWalk: every row\'s hops, grade and path describe ONE walk — a later, stronger record for an ancestor cannot rewrite a child\'s path', () => {
  const { g, S, X } = upgradeGraph();
  const w = chainWalk(g, { start: S, maxDepth: 3 });
  for (const row of [...w.services, ...w.statements]) {
    assert.equal(row.hops, row.path.length, `${row.id}: hops must be the number of edges walked`);
    assert.equal(row.grade, weakestOf(row.path), `${row.id}: grade must be the weakest link on its own path`);
    assert.ok(row.path.length <= w.depth, `${row.id}: a path cannot be longer than the depth cap`);
    for (let i = 1; i < row.path.length; i++) assert.equal(row.path[i].from, row.path[i - 1].to, `${row.id}: the path must chain`);
    if (row.path.length) assert.equal(row.path[0].from, S, `${row.id}: the path must start at the start`);
  }
  const x = w.services.find((s) => s.id === 'X');
  assert.equal(x.hops, 2);
  assert.equal(x.grade, 'SOUND_SET'); // reached through the candidate edge, in 2 hops
  assert.deepEqual(x.path.map((e) => e.grade), ['SOUND_SET', 'EXACT']);
  // …and the generic reachability query agrees on both numbers
  const reached = g.reach(S, { mode: 'conservative', maxHops: 3 }).get(X);
  assert.equal(reached.hops, 2);
  assert.equal(reached.pathGrade, 'SOUND_SET');
});

test('chainWalk: the best-record rule prefers a stronger grade, and on a tie the shorter path', () => {
  const { g, S } = upgradeGraph();
  const w = chainWalk(g, { start: S, maxDepth: 4 });
  // Y: SOUND_SET at 1 hop vs EXACT at 3 — the stronger grade wins even though it is longer.
  const y = w.services.find((s) => s.id === 'Y');
  assert.equal(y.grade, 'EXACT');
  assert.equal(y.hops, 3);
  assert.equal(y.path.length, 3);
  // A second diamond of EQUAL grades: S→P→Z (2 hops) and S→A→B→Z (3), all EXACT.
  const P = nodeId('symbol', 'P'), Z = nodeId('symbol', 'Z'), B = nodeId('symbol', 'B');
  g.addEdge({ from: S, to: P, type: 'CALLS', grade: 'EXACT' });
  g.addEdge({ from: P, to: Z, type: 'CALLS', grade: 'EXACT' });
  g.addEdge({ from: B, to: Z, type: 'CALLS', grade: 'EXACT' });
  const w2 = chainWalk(g, { start: S, maxDepth: 4 });
  const z = w2.services.find((s) => s.id === 'Z');
  assert.equal(z.grade, 'EXACT');
  assert.equal(z.hops, 2, 'a tie on grade is broken by the shorter path');
  assert.deepEqual(z.path.map((e) => e.from), [nodeId('symbol', 'S'), P]);
});

// ---------------------------------------------------------------------------
// ordering + aggregation rules, on a fixture where the RULE and the order the
// BFS happens to meet things in disagree.
//
//   S --MAY_CALL/SOUND_SET--> mA --IMPLEMENTS_STMT--> stA  ┐ met FIRST, hop 2
//   S --CALLS--> svc --CALLS--> mB --IMPLEMENTS_STMT--> stB ┘ met LATER, hop 3, EXACT
//   both statements EXECUTE table t
// ---------------------------------------------------------------------------

function tieGraph() {
  const S = nodeId('symbol', 'S'), SVC = nodeId('symbol', 'zzz.Svc#run');
  const mA = nodeId('symbol', 'mA'), mB = nodeId('symbol', 'mB');
  const stA = nodeId('statement', 'A.a'), stB = nodeId('statement', 'B.b');
  const T = nodeId('table', 't');
  const g = buildGraph([
    { fact: 'edge', from: S, to: mA, type: 'MAY_CALL', grade: 'SOUND_SET' },
    { fact: 'edge', from: mA, to: stA, type: 'IMPLEMENTS_STMT', grade: 'EXACT' },
    { fact: 'edge', from: S, to: SVC, type: 'CALLS', grade: 'EXACT' },
    { fact: 'edge', from: SVC, to: mB, type: 'CALLS', grade: 'EXACT' },
    { fact: 'edge', from: mB, to: stB, type: 'IMPLEMENTS_STMT', grade: 'EXACT' },
    { fact: 'edge', from: stA, to: T, type: 'EXECUTES', grade: 'EXACT', evidence: { access: 'read' } },
    { fact: 'edge', from: stB, to: T, type: 'EXECUTES', grade: 'EXACT', evidence: { access: 'write' } },
  ]);
  return { g, S, SVC, T };
}

test('chainWalk: a table aggregates its statements — hops is the SHALLOWEST, grade the STRONGEST, via the rule\'s winner (not the one met first)', () => {
  const { g, S } = tieGraph();
  const w = chainWalk(g, { start: S, maxDepth: 6 });
  assert.deepEqual(w.statements.map((s) => [s.id, s.hops, s.grade]), [['A.a', 2, 'SOUND_SET'], ['B.b', 3, 'EXACT']]);
  const t = w.tables.find((x) => x.table === 't');
  assert.equal(t.hops, 3);           // 2+1 from the shallower statement
  assert.equal(t.grade, 'EXACT');    // the strongest path that reaches it
  assert.equal(t.via, 'B.b');        // strongest grade first — A.a was reached (and met) first
  assert.equal(t.statements, 2);
  assert.equal(t.access, 'read+write');
});

test('chainWalk: inside a hop the lanes are ordered grade DESC, then id — a confirmed row is never listed under a candidate', () => {
  // Two rows at hop 1: an EXACT one whose id sorts LAST, and a SOUND_SET one
  // whose id sorts first. Only the grade rule can put the EXACT one on top.
  const S = nodeId('symbol', 'S');
  const g = buildGraph([
    { fact: 'edge', from: S, to: nodeId('symbol', 'aaa#x'), type: 'MAY_CALL', grade: 'SOUND_SET' },
    { fact: 'edge', from: S, to: nodeId('symbol', 'zzz#x'), type: 'CALLS', grade: 'EXACT' },
  ]);
  const w = chainWalk(g, { start: S });
  assert.deepEqual(w.services.map((s) => [s.id, s.hops, s.grade]), [['zzz#x', 1, 'EXACT'], ['aaa#x', 1, 'SOUND_SET']]);
});

test('chainWalk: a mapper method that calls another mapper method folds the WHOLE run — the statement links to a row that was drawn', () => {
  // S --CALLS--> svc --CALLS--> mapper1 --CALLS--> mapper2 --IMPLEMENTS_STMT--> st
  // mapper1 also implements its own statement, so both are folded away.
  const S = nodeId('symbol', 'S'), SVC = nodeId('symbol', 'Svc#run');
  const m1 = nodeId('symbol', 'M1#a'), m2 = nodeId('symbol', 'M2#b');
  const st1 = nodeId('statement', 'M1.a'), st2 = nodeId('statement', 'M2.b');
  const g = buildGraph([
    { fact: 'edge', from: S, to: SVC, type: 'CALLS', grade: 'EXACT' },
    { fact: 'edge', from: SVC, to: m1, type: 'CALLS', grade: 'EXACT' },
    { fact: 'edge', from: m1, to: st1, type: 'IMPLEMENTS_STMT', grade: 'EXACT' },
    { fact: 'edge', from: m1, to: m2, type: 'CALLS', grade: 'EXACT' },
    { fact: 'edge', from: m2, to: st2, type: 'IMPLEMENTS_STMT', grade: 'EXACT' },
  ]);
  const w = chainWalk(g, { start: S });
  const drawn = new Set([S, ...w.services.map((s) => nodeId('symbol', s.id))]);
  assert.deepEqual(w.services.map((s) => s.id), ['Svc#run'], 'both mapper methods are folded, neither is a service row');
  for (const st of w.statements) {
    assert.ok(drawn.has(st.link.from), `${st.id} links to ${st.link.from}, which no row rendered`);
  }
  // the deeper statement hangs off the SERVICE that entered the mapper run
  assert.equal(w.statements.find((s) => s.id === 'M2.b').link.from, SVC);
  assert.equal(w.statements.find((s) => s.id === 'M2.b').symbol, 'M2#b'); // …and still names its own mapper
});

test('chainWalk: a reached node that no lane can show is counted in `other`, never silently dropped', () => {
  // The handler calls out over HTTP and renders a screen: both are real hops of
  // this request, both are counted in `walked`, and neither is a lane row.
  const S = nodeId('symbol', 'S');
  const g = buildGraph([
    { fact: 'edge', from: S, to: nodeId('symbol', 'Svc#run'), type: 'CALLS', grade: 'EXACT' },
    { fact: 'edge', from: S, to: nodeId('endpoint', 'GET http://example.com/api'), type: 'CALLS_HTTP', grade: 'SOUND_SET' },
    { fact: 'edge', from: S, to: nodeId('screen', 'product-list'), type: 'RENDERS', grade: 'EXACT' },
  ]);
  const w = chainWalk(g, { start: S });
  assert.equal(w.walked, 3);
  assert.equal(w.services.length, 1);
  assert.equal(w.statements.length, 0);
  assert.equal(w.tables.length, 0);
  assert.equal(w.other, 2, 'the endpoint and the screen are reached, shown nowhere, and said out loud');
  // they are part of the layer census too (a layer is nodes, not rows)
  assert.deepEqual(w.layers.map((l) => [l.hops, l.nodes, l.services]), [[1, 3, 1]]);
  assert.equal(chainWalk(g, { start: S, mode: 'strict' }).other, 1); // the SOUND_SET http call is below the floor
});

test('chainWalk: a cycle back to the start does not make the start its own link', () => {
  // S --CALLS--> A --CALLS--> S: the start is reached again, but hop 0 is the
  // entry, not a row and not a graded link into anything.
  const S = nodeId('symbol', 'S'), A = nodeId('symbol', 'A');
  const g = buildGraph([
    { fact: 'edge', from: S, to: A, type: 'CALLS', grade: 'EXACT' },
    { fact: 'edge', from: A, to: S, type: 'MAY_CALL', grade: 'SOUND_SET' },
  ]);
  const w = chainWalk(g, { start: S });
  assert.deepEqual(w.services.map((s) => s.id), ['A']);
  assert.equal(w.walked, 1, 'the start is not counted as something the walk reached');
  assert.deepEqual(w.byLinkGrade, { EXACT: 1, SOUND_SET: 0, HEURISTIC: 0 });
  assert.deepEqual(w.layers, [
    { hops: 1, nodes: 1, services: 1, statements: 0, tables: 0, byLinkGrade: { EXACT: 1, SOUND_SET: 0, HEURISTIC: 0 } },
  ]);
});

// ---------------------------------------------------------------------------
// the folding rule, stated once and applied to EVERY row (not just statements)
//
//   S --CALLS--> mapper --CALLS--> Svc#run
// The mapper is folded away (it is the statement column), so the SERVICE above
// it must hang off the row that WAS drawn — the start — not off the mapper.
// ---------------------------------------------------------------------------

test('chainWalk: the fold rule applies to service rows too — a service under a folded mapper links to a drawn row', () => {
  const S = nodeId('symbol', 'S'), m = nodeId('symbol', 'M#a'), SVC = nodeId('symbol', 'Svc#run');
  const st = nodeId('statement', 'M.a');
  const g = buildGraph([
    { fact: 'edge', from: S, to: m, type: 'CALLS', grade: 'EXACT' },
    { fact: 'edge', from: m, to: st, type: 'IMPLEMENTS_STMT', grade: 'EXACT' },
    { fact: 'edge', from: m, to: SVC, type: 'CALLS', grade: 'EXACT' },
  ]);
  const w = chainWalk(g, { start: S });
  assert.deepEqual(w.services.map((s) => s.id), ['Svc#run'], 'the mapper is folded, so it is no service row');
  const drawn = new Set([S, ...w.services.map((s) => nodeId('symbol', s.id)), ...w.statements.map((s) => nodeId('statement', s.id))]);
  for (const row of [...w.services, ...w.statements]) {
    assert.ok(drawn.has(row.link.from), `${row.id} links to ${row.link.from}, which no row rendered`);
  }
  assert.equal(w.services[0].link.from, S, 'the service skips the folded mapper and hangs off the start');
  assert.equal(w.services[0].path.length, 2, '…while its own path still names every hop it really took');
});

// ---------------------------------------------------------------------------
// direction:'up' — the mirror walk (the Impact view): from a column / table /
// statement / method BACK to the HTTP endpoints that can reach it.
//
//   column p.name <--READS/WRITES-- statement <--IMPLEMENTS_STMT-- mapper
//     <--MAY_CALL-- PServiceImpl#load <--MAY_CALL-- PService#load
//     <--MAY_CALL-- PController#get <--HANDLES-- endpoint GET /p/{id}
// ---------------------------------------------------------------------------

const P_NAME = nodeId('column', 'p.name');
const up = (over = {}) => chainWalk(flowGraph(), { start: P_NAME, direction: 'up', maxDepth: 8, ...over });

test('chainWalk up: from a column — statements at hop 1, the first service at hop 3 (the mapper is folded at 2)', () => {
  const w = up();
  assert.equal(w.direction, 'up');
  assert.deepEqual(w.statements.map((s) => [s.id, s.hops, s.grade]), [
    [SELECT_STMT, 1, 'EXACT'], [UPDATE_STMT, 1, 'EXACT'],
  ]);
  // hop-1 rows hang off the TARGET itself — the only row above them on screen
  for (const s of w.statements) assert.equal(s.link.from, P_NAME);
  // …and each still names the mapper method folded into it (read from the
  // statement's own IMPLEMENTS_STMT in-edge: walking up, the mapper is ABOVE it)
  assert.equal(w.statements[0].symbol, 'com.x.PMapper#selectByPrimaryKey');
  const first = w.services.find((s) => s.id === 'com.x.PServiceImpl#load');
  assert.equal(first.hops, 3, 'column ← statement 1 ← mapper 2 ← impl 3');
  assert.equal(first.link.from, nodeId('statement', SELECT_STMT), 'it links to the statement, not to the folded mapper');
  assert.equal(w.services.some((s) => s.id.startsWith('com.x.PMapper#')), false, 'a mapper method is never a service row');
  // the tables lane is absent walking up: the target IS the table side
  assert.equal('tables' in w, false);
  assert.equal(w.endLane, 'endpoints');
});

test('chainWalk up: the handler is a service row flagged `handler`, and the endpoint above it is DERIVED', () => {
  const w = up();
  const handler = w.services.find((s) => s.id === 'com.x.PController#get');
  assert.equal(handler.handler, true, 'the controller method is real code — a row, not a route');
  assert.equal(handler.hops, 5);
  assert.equal(handler.grade, 'SOUND_SET');
  assert.equal(w.services.filter((s) => s.handler).length, 1);
  assert.equal(w.services.find((s) => s.id === 'com.x.PServiceImpl#load').handler, false);
  assert.deepEqual(w.endpoints.map(({ walkedPath, ...rest }) => rest), [{
    id: 'GET /p/{id}', httpMethod: 'GET', path: '/p/{id}',
    handler: 'com.x.PController#get', handlerShort: 'PController#get',
    hops: 6, grade: 'SOUND_SET', file: 'src/PController.java', line: 30,
  }]);
  assert.equal(w.endpoints[0].hops, handler.hops + 1, 'the route sits one hop above its handler');
  assert.equal(w.endpoints[0].grade, weakestOf(handler.path), 'and carries the weakest link on the handler\'s path');
  // the route is not a walked node: it is in no layer, and adds nothing to walked
  assert.equal(w.walked, 7); // 2 statements + 2 mappers + impl + iface + handler
  assert.equal(w.other, 0);
});

test('chainWalk up: every path reads from the target outward, and each element is the REAL edge', () => {
  const w = up();
  for (const row of [...w.statements, ...w.services]) {
    assert.equal(row.hops, row.path.length, `${row.id}: hops must be the number of edges walked`);
    assert.equal(row.grade, weakestOf(row.path), `${row.id}: grade is the weakest link on its own path`);
    // walking up, an edge is caller→callee read BACKWARDS: to === previous.from
    for (let i = 1; i < row.path.length; i++) assert.equal(row.path[i].to, row.path[i - 1].from, `${row.id}: the path must chain`);
    assert.equal(row.path[0].to, P_NAME, `${row.id}: the path must start at the target`);
  }
  const handler = w.services.find((s) => s.id === 'com.x.PController#get');
  assert.deepEqual(handler.path.map((e) => e.type),
    ['READS', 'IMPLEMENTS_STMT', 'MAY_CALL', 'MAY_CALL', 'MAY_CALL']);
  assert.equal(handler.path[0].from, nodeId('statement', SELECT_STMT));
  assert.equal(handler.path[handler.path.length - 1].from, nodeId('symbol', 'com.x.PController#get'));
});

test('chainWalk up: from a TABLE the statements that execute it are hop 1, and the chain above is the same', () => {
  const w = chainWalk(flowGraph(), { start: nodeId('table', 'q'), direction: 'up', maxDepth: 8 });
  assert.deepEqual(w.statements.map((s) => [s.id, s.hops]), [[UPDATE_STMT, 1]]);
  assert.equal(w.statements[0].link.from, nodeId('table', 'q'));
  assert.deepEqual(w.endpoints.map((e) => [e.id, e.hops]), [['GET /p/{id}', 6]]);
});

test('chainWalk up: strict sees the EXACT SQL edges but no call above them — and says the mode did it', () => {
  const w = up({ mode: 'strict' });
  assert.deepEqual(w.statements.map((s) => s.id), [SELECT_STMT, UPDATE_STMT], 'READS/WRITES/IMPLEMENTS_STMT are EXACT');
  assert.equal(w.services.length, 0);
  assert.equal(w.endpoints.length, 0);
  assert.ok(w.cut.byMode > 0, 'the mapper→service links are MAY_CALL, below the strict floor');
  assert.equal(w.cut.byMode, 2); // both mapper methods' MAY_CALL in-edges from the impl
  assert.equal(w.cut.depth, 0);
});

test('chainWalk up: a STATEMENT target has no statements lane — that is the axis, not an absence', () => {
  const w = chainWalk(flowGraph(), { start: nodeId('statement', SELECT_STMT), direction: 'up', maxDepth: 8 });
  assert.deepEqual(w.statements, []);
  assert.equal(w.emptyReason.statements, 'not-in-this-axis');
  assert.deepEqual(w.services.map((s) => [s.id, s.hops]), [
    ['com.x.PServiceImpl#load', 2], ['com.x.PService#load', 3], ['com.x.PController#get', 4],
  ]);
  assert.equal(w.services[0].link.from, nodeId('statement', SELECT_STMT), 'the first service hangs off the target');
  assert.deepEqual(w.endpoints.map((e) => [e.id, e.hops]), [['GET /p/{id}', 5]]);
});

test('chainWalk up: a SYMBOL target returns services (and the endpoints above them) only', () => {
  const w = chainWalk(flowGraph(), { start: IMPL, direction: 'up', maxDepth: 8 });
  assert.deepEqual(w.statements, []);
  assert.equal(w.emptyReason.statements, 'not-in-this-axis');
  assert.deepEqual(w.services.map((s) => [s.id, s.hops, s.handler]), [
    ['com.x.PService#load', 1, false], ['com.x.PController#get', 2, true],
  ]);
  assert.deepEqual(w.endpoints.map((e) => [e.id, e.hops, e.grade]), [['GET /p/{id}', 3, 'SOUND_SET']]);
});

test('chainWalk up: from the HANDLER itself the route above it is still the answer — hop 1, EXACT', () => {
  // hop 0 is the start and is never a row, but "which endpoints reach this
  // method" is exactly what was asked: the definitional HANDLES edge answers it.
  const w = chainWalk(flowGraph(), { start: HANDLER, direction: 'up', maxDepth: 8 });
  assert.equal(w.walked, 0);
  assert.deepEqual(w.services, []);
  assert.deepEqual(w.endpoints.map((e) => [e.id, e.hops, e.grade]), [['GET /p/{id}', 1, 'EXACT']]);
});

test('chainWalk up: a STATEMENT at the cap hides its mapper and every caller above it — that is a cut, and it is counted', () => {
  // Walking up, nothing below a statement is derived from its own edges (that
  // is the DOWN direction's trick), so a statement sitting at the cap really
  // does hide work: the mapper method, and the whole call chain above it.
  const atStatements = up({ maxDepth: 1 });
  assert.deepEqual(atStatements.statements.map((s) => s.id), [SELECT_STMT, UPDATE_STMT]);
  assert.deepEqual(atStatements.services, []);
  assert.deepEqual(atStatements.endpoints, []);
  assert.equal(atStatements.cut.depth, 2, 'both statements had an unwalked IMPLEMENTS_STMT caller above them');
  // …while the SAME boundary walking DOWN claims nothing, because there its
  // tables and columns come from the statement's own edges (pinned above too).
  assert.equal(walk({ maxDepth: 4 }).cut.depth, 0);
});

test('chainWalk up: a table/column at the cap is not a cut — only symbols and statements can hide callers', () => {
  // depth 1 from a SYMBOL: the boundary is the service interface (a symbol) …
  const atIface = chainWalk(flowGraph(), { start: IMPL, direction: 'up', maxDepth: 1 });
  assert.equal(atIface.cut.depth, 1);
  // … and a walk whose whole reach is one statement's SQL side has no boundary
  // of either counting kind, so it claims none.
  const none = chainWalk(flowGraph(), { start: nodeId('column', 'z.k'), direction: 'up', maxDepth: 1 });
  assert.equal(none.cut.depth, 0);
});

test('chainWalk up: cut.depth counts unfollowed CALLERS — a handler at the cap hides nothing (its route is derived)', () => {
  // depth 3: the boundary is the service IMPL, whose caller was not walked.
  const atImpl = up({ maxDepth: 3 });
  assert.equal(atImpl.cut.depth, 1);
  assert.deepEqual(atImpl.services.map((s) => s.id), ['com.x.PServiceImpl#load']);
  assert.deepEqual(atImpl.endpoints, []);
  // depth 5: the boundary is the HANDLER. Its only remaining in-edge is HANDLES,
  // which is the derived endpoints lane, not a step — so nothing is hidden…
  const atHandler = up({ maxDepth: 5 });
  assert.equal(atHandler.cut.depth, 0);
  // …and the route one hop past the cap is known, not walked, and counted apart
  assert.deepEqual(atHandler.endpoints.map((e) => [e.id, e.hops]), [['GET /p/{id}', 6]]);
  assert.deepEqual(atHandler.beyond, { endpoints: 1 });
  assert.equal(atHandler.layers.every((l) => l.endpoints === 0), true, 'a derived row past the cap is in no layer');
  // depth 8 walks the whole thing: nothing cut, nothing beyond
  const full = up();
  assert.equal(full.cut.depth, 0);
  assert.deepEqual(full.beyond, { endpoints: 0 });
});

test('chainWalk up: layers fold the reverse walk per hop, and the grade counts still sum to byLinkGrade', () => {
  const w = up();
  assert.deepEqual(w.layers.map((l) => [l.hops, l.nodes, l.statements, l.services, l.endpoints]), [
    [1, 2, 2, 0, 0],   // the two statements
    [2, 2, 0, 0, 0],   // the two mapper methods — folded, so no row of their own
    [3, 1, 0, 1, 0],   // the impl
    [4, 1, 0, 1, 0],   // the interface
    [5, 1, 0, 1, 0],   // the handler
    [6, 0, 0, 0, 1],   // the route: derived, so it is counted here but is not a walked node
  ]);
  for (const g of ['EXACT', 'SOUND_SET', 'HEURISTIC']) {
    assert.equal(w.layers.reduce((n, l) => n + l.byLinkGrade[g], 0), w.byLinkGrade[g], `byLinkGrade.${g}`);
  }
  assert.equal(w.layers.reduce((n, l) => n + l.nodes, 0), w.walked);
  for (const lane of ['statements', 'services']) {
    assert.deepEqual(w.layers.map((l) => l[lane]),
      w.layers.map((l) => w[lane].filter((r) => r.hops === l.hops).length), lane);
  }
});

test('chainWalk up: a JOINS-only neighbour never leads anywhere — schema is not flow, in either direction', () => {
  // z is joined to p and touched by no statement: walking up from z.k must not
  // climb DECLARES to table z, then JOINS to p, and inherit p's endpoints.
  const w = chainWalk(flowGraph(), { start: nodeId('column', 'z.k'), direction: 'up', maxDepth: 8 });
  assert.deepEqual(w.statements, []);
  assert.deepEqual(w.services, []);
  assert.deepEqual(w.endpoints, []);
  assert.equal(w.walked, 0);
  assert.equal(w.cut.byMode, 0, 'nothing was withheld by the mode — there is simply no flow edge here');
});

test('chainWalk up: two runs over the same facts are deep-equal, and a bad direction throws ChainError', () => {
  assert.deepEqual(up(), up());
  assert.throws(() => chainWalk(flowGraph(), { start: P_NAME, direction: 'sideways' }),
    (e) => e instanceof ChainError && /unknown direction/.test(e.message));
});

// ---------------------------------------------------------------------------
// the DRAW LINK — a row hangs off the nearest DRAWN row, but the step it
// reports is the WEAKEST edge of the run that was folded into it. Hand-built
// graphs, because the Java lane only ever emits MAY_CALL/SOUND_SET and these
// cases need an EXACT call next to a candidate one.
// ---------------------------------------------------------------------------

const symId = (k) => nodeId('symbol', k);
const stmtId = (k) => nodeId('statement', k);

// S#run -CALLS/EXACT-> M1#a -MAY_CALL/SOUND_SET-> M2#b -IMPLEMENTS_STMT-> M2.b
// Both M1#a and M2#b are mapper methods, so BOTH are folded away and the run
// from the drawn parent (the start) to the statement row is three edges long.
function foldedDownGraph() {
  return buildGraph([
    { fact: 'node', id: symId('S#run'), owner: 'S', file: 'src/S.java', line: 3 },
    { fact: 'node', id: symId('M1#a'), owner: 'M1' },
    { fact: 'node', id: symId('M2#b'), owner: 'M2' },
    { fact: 'node', id: stmtId('M1.a'), statementType: 'select' },
    { fact: 'node', id: stmtId('M2.b'), statementType: 'update' },
    { fact: 'node', id: nodeId('table', 't') },
    { fact: 'edge', from: symId('S#run'), to: symId('M1#a'), type: 'CALLS', grade: 'EXACT', evidence: { basis: 'unique target' } },
    { fact: 'edge', from: symId('M1#a'), to: stmtId('M1.a'), type: 'IMPLEMENTS_STMT', grade: 'EXACT' },
    { fact: 'edge', from: symId('M1#a'), to: symId('M2#b'), type: 'MAY_CALL', grade: 'SOUND_SET', evidence: { basis: 'parse-tree receiver→field→type', receiver: 'm2' } },
    { fact: 'edge', from: symId('M2#b'), to: stmtId('M2.b'), type: 'IMPLEMENTS_STMT', grade: 'EXACT' },
    { fact: 'edge', from: stmtId('M2.b'), to: nodeId('table', 't'), type: 'EXECUTES', grade: 'EXACT', evidence: { access: 'write' } },
  ]);
}

test('drawLink down: a three-edge folded run reports its WEAKEST step, not the first one', () => {
  const w = chainWalk(foldedDownGraph(), { start: symId('S#run'), maxDepth: 6 });
  const near = w.statements.find((s) => s.id === 'M1.a');
  const far = w.statements.find((s) => s.id === 'M2.b');
  // one folded mapper, both edges EXACT → the step is the CALLS edge itself
  assert.equal(near.link.from, symId('S#run'));
  assert.deepEqual([near.link.type, near.link.grade], ['CALLS', 'EXACT']);
  assert.equal(near.grade, 'EXACT');
  // two folded mappers: CALLS/EXACT → MAY_CALL/SOUND_SET → IMPLEMENTS_STMT/EXACT.
  // The row still hangs off S#run (the only drawn row above it), but a
  // SOUND_SET row must not be justified by the EXACT edge that touches it.
  assert.equal(far.hops, 3);
  assert.equal(far.grade, 'SOUND_SET');
  assert.equal(far.link.from, symId('S#run'), 'it hangs off the nearest DRAWN row');
  assert.deepEqual([far.link.type, far.link.grade], ['MAY_CALL', 'SOUND_SET']);
  assert.equal(far.link.receiver, 'm2', 'and carries that edge\'s evidence');
  for (const row of [...w.services, ...w.statements]) {
    assert.equal(row.link.grade, row.grade, `${row.id}: a row's link may not be graded above the row`);
  }
});

// column t.c <-READS- M.s <-IMPLEMENTS_STMT- M#s <-MAY_CALL- A#run  (candidate)
//                                                 <-CALLS-  B#run  (confirmed)
//                                                            ^-CALLS- C#run
// routes: GET /a → A#run, GET /b → B#run, GET /c → C#run, GET /d → A#run AND B#run
function upLinkGraph() {
  const facts = [
    { fact: 'node', id: nodeId('column', 't.c') },
    { fact: 'node', id: stmtId('M.s'), statementType: 'select' },
    { fact: 'node', id: symId('M#s'), owner: 'M' },
    { fact: 'node', id: symId('A#run'), owner: 'A', file: 'src/A.java', line: 7 },
    { fact: 'node', id: symId('B#run'), owner: 'B', file: 'src/B.java', line: 8 },
    { fact: 'node', id: symId('C#run'), owner: 'C', file: 'src/C.java', line: 9 },
    { fact: 'edge', from: stmtId('M.s'), to: nodeId('column', 't.c'), type: 'READS', grade: 'EXACT' },
    { fact: 'edge', from: symId('M#s'), to: stmtId('M.s'), type: 'IMPLEMENTS_STMT', grade: 'EXACT' },
    { fact: 'edge', from: symId('A#run'), to: symId('M#s'), type: 'MAY_CALL', grade: 'SOUND_SET', evidence: { basis: 'parse-tree receiver→field→type', receiver: 'mapper', iface: 'M' } },
    { fact: 'edge', from: symId('B#run'), to: symId('M#s'), type: 'CALLS', grade: 'EXACT', evidence: { basis: 'unique target' } },
    { fact: 'edge', from: symId('C#run'), to: symId('B#run'), type: 'CALLS', grade: 'EXACT' },
  ];
  for (const [route, handler] of [['GET /a', 'A#run'], ['GET /b', 'B#run'], ['GET /c', 'C#run'], ['GET /d', 'A#run'], ['GET /d', 'B#run']]) {
    facts.push({ fact: 'node', id: nodeId('endpoint', route), httpMethod: route.split(' ')[0], path: route.split(' ')[1], file: `src/${handler[0]}.java` });
    facts.push({ fact: 'edge', from: nodeId('endpoint', route), to: symId(handler), type: 'HANDLES', grade: 'EXACT' });
  }
  return buildGraph(facts);
}

test('drawLink up: a service reached through a candidate call reports THAT call, not the EXACT edge under it', () => {
  const w = chainWalk(upLinkGraph(), { start: nodeId('column', 't.c'), direction: 'up', maxDepth: 8 });
  const a = w.services.find((s) => s.id === 'A#run');
  // the mapper method is folded, so the row hangs off the statement…
  assert.equal(a.link.from, stmtId('M.s'));
  assert.equal(a.link.fromShort, 'M.s');
  // …but the run statement ← mapper ← A#run is IMPLEMENTS_STMT/EXACT then
  // MAY_CALL/SOUND_SET, and it is the candidate call the reader must weigh.
  assert.equal(a.grade, 'SOUND_SET');
  assert.deepEqual([a.link.type, a.link.grade], ['MAY_CALL', 'SOUND_SET']);
  assert.equal(a.link.receiver, 'mapper');
  assert.equal(a.link.iface, 'M');
  assert.match(a.link.basis, /parse-tree/);
  // An all-EXACT run keeps the edge NEAREST the drawn parent (the line's own
  // first hop) — the tie rule, applied where no edge is weaker.
  const b = w.services.find((s) => s.id === 'B#run');
  assert.equal(b.grade, 'EXACT');
  assert.deepEqual([b.link.from, b.link.type, b.link.grade], [stmtId('M.s'), 'IMPLEMENTS_STMT', 'EXACT']);
  for (const row of [...w.statements, ...w.services]) {
    assert.equal(row.link.grade, row.grade, `${row.id}: a row's link may not be graded above the row`);
  }
});

test('chainWalk up: an endpoint row carries its own walked path — the handler\'s, plus the HANDLES edge', () => {
  const w = chainWalk(upLinkGraph(), { start: nodeId('column', 't.c'), direction: 'up', maxDepth: 8 });
  const ep = w.endpoints.find((e) => e.id === 'GET /a');
  assert.equal(ep.path, '/a', 'the ROUTE stays on `path`');
  const handler = w.services.find((s) => s.id === 'A#run');
  assert.deepEqual(ep.walkedPath.map((e) => e.type), [...handler.path.map((e) => e.type), 'HANDLES']);
  assert.equal(ep.walkedPath.length, ep.hops, 'one edge per hop, like every other row');
  // same orientation as the other up rows: it reads from the target outward and chains
  assert.equal(ep.walkedPath[0].to, nodeId('column', 't.c'));
  for (let i = 1; i < ep.walkedPath.length; i++) assert.equal(ep.walkedPath[i].to, ep.walkedPath[i - 1].from);
  const last = ep.walkedPath[ep.walkedPath.length - 1];
  assert.deepEqual([last.from, last.to, last.type, last.grade], [nodeId('endpoint', 'GET /a'), symId('A#run'), 'HANDLES', 'EXACT']);
  assert.equal(ep.grade, weakestOf(ep.walkedPath), 'the grade on the row is the weakest step of the path it shows');
});

test('chainWalk up: one route with TWO handlers takes the nearest hop and the strongest grade', () => {
  const w = chainWalk(upLinkGraph(), { start: nodeId('column', 't.c'), direction: 'up', maxDepth: 8 });
  const d = w.endpoints.find((e) => e.id === 'GET /d');
  const a = w.services.find((s) => s.id === 'A#run');
  const b = w.services.find((s) => s.id === 'B#run');
  assert.equal(a.hops, 3); assert.equal(b.hops, 3);
  assert.equal(d.hops, Math.min(a.hops, b.hops) + 1);
  assert.equal(d.grade, 'EXACT', 'the strongest way in decides the route grade');
  assert.equal(d.handler, 'B#run', 'and the representative handler is the one that grade came from');
  assert.equal(d.walkedPath[d.walkedPath.length - 1].to, symId('B#run'), 'the path shown is that handler\'s');
});

test('chainWalk up: the endpoints lane is ordered hops asc, grade desc, id asc — checked against a sorted copy', () => {
  const w = chainWalk(upLinkGraph(), { start: nodeId('column', 't.c'), direction: 'up', maxDepth: 8 });
  assert.deepEqual(w.endpoints.map((e) => [e.id, e.hops, e.grade]), [
    ['GET /b', 4, 'EXACT'], ['GET /d', 4, 'EXACT'], ['GET /a', 4, 'SOUND_SET'], ['GET /c', 5, 'EXACT'],
  ], 'mixed hops AND grades, so every key of the order is exercised');
  const rank = { UNRESOLVED: 0, RUNTIME_ONLY: 1, HEURISTIC: 2, SOUND_SET: 3, EXACT: 4 };
  const independently = [...w.endpoints].sort((x, y) => (x.hops - y.hops)
    || (rank[y.grade] - rank[x.grade]) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  assert.deepEqual(w.endpoints, independently);
});

test('chainWalk up: an endpoint EXACTLY at the depth cap is listed, not `beyond` (the boundary is <=)', () => {
  const start = nodeId('column', 't.c');
  const at = chainWalk(upLinkGraph(), { start, direction: 'up', maxDepth: 5 });
  const c = at.endpoints.find((e) => e.id === 'GET /c');
  assert.equal(c.hops, 5, 'exactly at the cap');
  assert.deepEqual(at.beyond, { endpoints: 0 }, 'at the cap is INSIDE the walk');
  assert.equal(at.layers.find((l) => l.hops === 5).endpoints, 1, 'and it sits in its own layer');
  assert.equal(at.cut.depth, 0, 'nothing was left expanding at the cap');
  // one hop shallower, the same route is past the cap: known, in no layer, counted apart
  const past = chainWalk(upLinkGraph(), { start, direction: 'up', maxDepth: 4 });
  assert.equal(past.endpoints.find((e) => e.id === 'GET /c').hops, 5);
  assert.deepEqual(past.beyond, { endpoints: 1 });
  assert.equal(past.layers.every((l) => l.hops !== 5), true);
});

test('chainWalk up from a statement at depth 1: the mapper above it is named even when unwalked', () => {
  // depth 1 cannot step onto the mapper method, but `symbol` is read from the
  // statement's own IMPLEMENTS_STMT in-edge — the fallback branch of mapperAbove.
  const g = upLinkGraph();
  const deep = chainWalk(g, { start: nodeId('column', 't.c'), direction: 'up', maxDepth: 8 });
  const shallow = chainWalk(g, { start: nodeId('column', 't.c'), direction: 'up', maxDepth: 1 });
  assert.equal(deep.statements[0].symbol, 'M#s');
  assert.equal(shallow.statements[0].symbol, 'M#s', 'the name does not depend on the walk reaching it');
  assert.deepEqual(shallow.services, []);
  assert.equal(shallow.cut.depth, 1, 'the statement at the cap hides its mapper and everything above');
});

// ---------------------------------------------------------------------------
// The INTERNAL HTTP HOP (RM14, SPEC §1.1)
//
// Two deployables in ONE pack. Module A serves `/order/{id}`; its handler calls
// a @FeignClient method, which calls module B's route `/stock/{id}`; B's handler
// reads `stock.qty`. The request really does run from A's route to B's column,
// and the walk must cross that in both directions — while SAYING it crossed,
// because the code on the far side is another deployable, not one call stack.
//
// Built from the JAVA BRIDGE, not by hand-writing the two edges: the classifier
// that turns a @FeignClient mapping into CALLS_HTTP instead of HANDLES is half
// of what is under test here.
// ---------------------------------------------------------------------------

function twoModuleGraph() {
  const g = buildGraphFromSql(
    [
      { kind: 'table', schema: null, table: 'stock', comment: null },
      { kind: 'column', schema: null, table: 'stock', column: 'id', type: 'INT', comment: null, pk: true },
      { kind: 'column', schema: null, table: 'stock', column: 'qty', type: 'INT', comment: null },
    ],
    [{
      kind: 'lineage', namespace: 'b.StockMapper', id: 'selectById', type: 'select',
      tables: [{ table: 'stock', access: 'read' }],
      columns: [{ table: 'stock', column: 'qty', access: 'read' }],
      file: 'b/StockMapper.xml', line: 3,
    }],
  );
  addJavaFacts(g, [
    // ---- module A: the caller -------------------------------------------
    { kind: 'type', fqn: 'a.OrderController', typeKind: 'class', package: 'a', annotations: ['RestController'], implements: [], declaredMethods: ['detail/1'], file: 'a/OrderController.java' },
    { kind: 'type',
      fqn: 'a.StockClient',
      typeKind: 'interface',
      package: 'a',
      annotations: ['FeignClient'],
      implements: [],
      declaredMethods: ['byId/1'],
      client: { kind: 'FeignClient', service: 'stock-service', serviceLiteral: true, url: null, path: null },
      file: 'a/StockClient.java' },
    { kind: 'field', owner: 'a.OrderController', name: 'client', typeSimple: 'StockClient', file: 'a/OrderController.java' },
    { kind: 'endpoint', httpMethod: 'GET', path: '/order/{id}', handler: 'a.OrderController#detail', handlerType: 'a.OrderController', line: 11, file: 'a/OrderController.java' },
    { kind: 'endpoint', httpMethod: 'GET', path: '/stock/{id}', handler: 'a.StockClient#byId', handlerType: 'a.StockClient', line: 7, file: 'a/StockClient.java' },
    { kind: 'call', from: 'a.OrderController#detail', receiver: 'client', method: 'byId', toTypeSimple: 'StockClient', via: 'field', file: 'a/OrderController.java' },
    // ---- module B: the deployable that answers ---------------------------
    { kind: 'type', fqn: 'b.StockController', typeKind: 'class', package: 'b', annotations: ['RestController'], implements: [], declaredMethods: ['byId/1'], file: 'b/StockController.java' },
    { kind: 'type', fqn: 'b.StockMapper', typeKind: 'interface', package: 'b', annotations: ['Mapper'], implements: [], declaredMethods: ['selectById/1'], file: 'b/StockMapper.java' },
    { kind: 'field', owner: 'b.StockController', name: 'mapper', typeSimple: 'StockMapper', file: 'b/StockController.java' },
    { kind: 'endpoint', httpMethod: 'GET', path: '/stock/{id}', handler: 'b.StockController#byId', handlerType: 'b.StockController', line: 9, file: 'b/StockController.java' },
    { kind: 'method', fqn: 'b.StockMapper#selectById', owner: 'b.StockMapper', name: 'selectById', paramCount: 1, line: 4, file: 'b/StockMapper.java' },
    { kind: 'call', from: 'b.StockController#byId', receiver: 'mapper', method: 'selectById', toTypeSimple: 'StockMapper', via: 'field', file: 'b/StockController.java' },
  ]);
  return g;
}

test('the HTTP hop: a @FeignClient mapping is a CALLS_HTTP call, never a second HANDLES', () => {
  const g = twoModuleGraph();
  const route = nodeId('endpoint', 'GET /stock/{id}');
  const handles = g.outEdges(route).filter((e) => e.type === 'HANDLES').map((e) => e.to);
  assert.deepEqual(handles, [nodeId('symbol', 'b.StockController#byId')],
    'the route is served ONCE — by the controller, not also by the client that calls it');
  const http = g.inEdges(route).filter((e) => e.type === 'CALLS_HTTP');
  assert.equal(http.length, 1);
  assert.equal(http[0].from, nodeId('symbol', 'a.StockClient#byId'));
  assert.equal(http[0].grade, 'SOUND_SET', 'a route this pack DOES serve');
  const ev = g.edgeAt(http[0].idx).evidence;
  assert.equal(ev.rule, 'http-client');
  assert.equal(ev.service, 'stock-service');
  assert.equal(ev.target, 'in-pack');
});

test('the HTTP hop, walking DOWN: A\'s handler reaches B\'s table, and every row says it crossed', () => {
  const w = chainWalk(twoModuleGraph(), {
    start: nodeId('symbol', 'a.OrderController#detail'), direction: 'down', maxDepth: 8,
  });
  //  detail -1-> StockClient#byId -2-> GET /stock/{id} -3-> StockController#byId
  //         -4-> StockMapper#selectById -5-> statement -6-> table
  const svc = Object.fromEntries(w.services.map((s) => [s.id, s]));
  assert.equal(svc['a.StockClient#byId'].viaHttp, undefined, 'the client method is on THIS side of the hop');
  assert.deepEqual(
    [svc['b.StockController#byId'].viaHttp, svc['b.StockController#byId'].httpHops], [true, 1],
    'the handler on the far side is across one hop, and says so',
  );
  assert.equal(w.statements.length, 1);
  assert.equal(w.statements[0].id, 'b.StockMapper.selectById');
  assert.deepEqual([w.statements[0].viaHttp, w.statements[0].httpHops], [true, 1]);
  assert.deepEqual(w.tables.map((t) => [t.table, t.viaHttp, t.httpHops]), [['stock', true, 1]]);
  // The hop cost two real steps (CALLS_HTTP then HANDLES): the depth accounting
  // counts them, it does not teleport across.
  assert.equal(svc['b.StockController#byId'].hops, 3);
  assert.equal(w.statements[0].hops, 5);
  // The route in the middle is a node the walk stepped on and no DOWN lane shows.
  assert.equal(w.other, 1);
  // Weakest link: the CALLS_HTTP edge is SOUND_SET, so nothing past it is EXACT.
  assert.equal(w.statements[0].grade, 'SOUND_SET');
});

test('the HTTP hop, walking UP: a column in B reaches the route in A, marked with the hop', () => {
  const w = chainWalk(twoModuleGraph(), {
    start: nodeId('column', 'stock.qty'), direction: 'up', maxDepth: 8,
  });
  const eps = Object.fromEntries(w.endpoints.map((e) => [e.id, e]));
  assert.deepEqual(Object.keys(eps).sort(), ['GET /order/{id}', 'GET /stock/{id}'],
    'the route that was hit AND the route upstream of the hop');
  // B's own route: reached without crossing anything, so it is not marked.
  assert.equal(eps['GET /stock/{id}'].viaHttp, undefined);
  assert.equal(eps['GET /stock/{id}'].hops, 4);
  // A's route: only reachable across the hop, and it says so.
  assert.deepEqual([eps['GET /order/{id}'].viaHttp, eps['GET /order/{id}'].httpHops], [true, 1]);
  //  qty -1-> statement -2-> mapper -3-> B#byId -4-> GET /stock -5-> client -6-> A#detail, route at 7
  assert.equal(eps['GET /order/{id}'].hops, 7);
  assert.equal(eps['GET /order/{id}'].grade, 'SOUND_SET');
  // The client method is a code row on the far side of the hop from the start.
  const client = w.services.find((s) => s.id === 'a.StockClient#byId');
  assert.deepEqual([client.viaHttp, client.httpHops], [true, 1]);
  // The route the walk STEPPED on to get there is shown as an endpoint, so it is
  // not also counted as a node no lane could show.
  assert.equal(w.other, 0);
});

test('the HTTP hop is not crossed when the mode floor or the edge types forbid it', () => {
  const g = twoModuleGraph();
  const start = nodeId('column', 'stock.qty');
  // strict: MAY_CALL and CALLS_HTTP are both SOUND_SET, so the walk stops at the
  // mapper — the hop is not the only thing missing, and nothing is claimed.
  const strict = chainWalk(g, { start, direction: 'up', mode: 'strict', maxDepth: 8 });
  assert.deepEqual(strict.endpoints, []);
  // A caller that asks for a flow set WITHOUT CALLS_HTTP gets the old picture:
  // B's own route, and no step onto it as a hop.
  const noHttp = chainWalk(g, {
    start, direction: 'up', maxDepth: 8, edgeTypes: FLOW_EDGE_TYPES.filter((t) => t !== 'CALLS_HTTP'),
  });
  assert.deepEqual(noHttp.endpoints.map((e) => e.id), ['GET /stock/{id}']);
});

test('a route this pack CALLS and does not serve is UNRESOLVED, marked outbound, and walked from by nobody', () => {
  const g = new Graph();
  addJavaFacts(g, [
    { kind: 'type',
      fqn: 'a.BillingClient',
      typeKind: 'interface',
      package: 'a',
      annotations: ['FeignClient'],
      implements: [],
      declaredMethods: ['charge/1'],
      client: { kind: 'FeignClient', service: 'BILLING', serviceLiteral: false, url: null, path: '/billing' },
      file: 'a/BillingClient.java' },
    { kind: 'endpoint', httpMethod: 'POST', path: '/billing/charge', handler: 'a.BillingClient#charge', handlerType: 'a.BillingClient', line: 5, file: 'a/BillingClient.java' },
  ]);
  const target = nodeId('endpoint', 'POST /billing/charge');
  assert.equal(g.nodes.get(target).outbound, true);
  assert.deepEqual(g.outEdges(target).filter((e) => e.type === 'HANDLES'), []);
  const e = g.edges.find((x) => x.type === 'CALLS_HTTP');
  assert.equal(e.grade, 'UNRESOLVED', 'nothing here answers it, so nothing is claimed about where it lands');
  assert.equal(e.evidence.target, 'outside-pack');
  assert.equal(e.evidence.serviceLiteral, false, 'the annotation named a CONSTANT, and the evidence says so');
  // No mode follows an UNRESOLVED edge, so the walk cannot wander out of the pack.
  const w = chainWalk(g, { start: nodeId('symbol', 'a.BillingClient#charge'), direction: 'down', mode: 'heuristic' });
  assert.equal(w.walked, 0);
});
