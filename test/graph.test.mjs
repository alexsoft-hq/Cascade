import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NODE_KINDS,
  EDGE_TYPES,
  GRADE_SETS,
  nodeId,
  Graph,
  buildGraph,
  GraphError,
} from '../src/core/graph.mjs';

// ---------------------------------------------------------------------------
// nodeId
// ---------------------------------------------------------------------------

test('nodeId: joins kind and key with a colon', () => {
  assert.equal(nodeId('column', 'main.T.C'), 'column:main.T.C');
});

test('nodeId: valid for every kind in NODE_KINDS', () => {
  for (const kind of NODE_KINDS) {
    assert.equal(nodeId(kind, 'k'), `${kind}:k`);
  }
});

test('nodeId: throws GraphError on an unknown kind', () => {
  assert.throws(() => nodeId('widget', 'k'), GraphError);
});

test('nodeId: throws GraphError on an empty string key', () => {
  assert.throws(() => nodeId('column', ''), GraphError);
});

test('nodeId: throws GraphError on a non-string key', () => {
  assert.throws(() => nodeId('column', 123), GraphError);
});

// ---------------------------------------------------------------------------
// Graph.addNode
// ---------------------------------------------------------------------------

test('addNode: adding the same id twice with different attrs merges into one node', () => {
  const g = new Graph();
  g.addNode({ id: nodeId('table', 'main.T'), name: 'T' });
  g.addNode({ id: nodeId('table', 'main.T'), owner: 'x' });
  assert.equal(g.nodes.size, 1);
  const n = g.nodes.get(nodeId('table', 'main.T'));
  assert.equal(n.name, 'T');
  assert.equal(n.owner, 'x');
});

test('addNode: throws GraphError when node.id is missing', () => {
  const g = new Graph();
  assert.throws(() => g.addNode({}), GraphError);
});

test('addNode: throws GraphError when id has an unknown kind prefix', () => {
  const g = new Graph();
  assert.throws(() => g.addNode({ id: 'widget:x' }), GraphError);
});

// ---------------------------------------------------------------------------
// Graph.addEdge
// ---------------------------------------------------------------------------

test('addEdge: auto-creates missing endpoint nodes as stubs regardless of ingest order', () => {
  const g = new Graph();
  const from = nodeId('screen', 'S');
  const to = nodeId('endpoint', 'E');
  g.addEdge({ from, to, type: 'RENDERS', grade: 'EXACT' });
  assert.ok(g.nodes.has(from), 'from node should be auto-created');
  assert.ok(g.nodes.has(to), 'to node should be auto-created');
  assert.equal(g.nodes.get(from).stub, true);
  assert.equal(g.nodes.get(to).stub, true);
});

test('addEdge: throws GraphError on an unknown edge type', () => {
  const g = new Graph();
  assert.throws(
    () => g.addEdge({ from: nodeId('screen', 'S'), to: nodeId('endpoint', 'E'), type: 'CAllS', grade: 'EXACT' }),
    GraphError,
  );
});

test('addEdge: throws GraphError on an unknown grade', () => {
  const g = new Graph();
  assert.throws(
    () => g.addEdge({ from: nodeId('screen', 'S'), to: nodeId('endpoint', 'E'), type: 'RENDERS', grade: 'MAYBE' }),
    GraphError,
  );
});

test('addEdge: throws GraphError when from is missing', () => {
  const g = new Graph();
  assert.throws(
    () => g.addEdge({ to: nodeId('endpoint', 'E'), type: 'RENDERS', grade: 'EXACT' }),
    GraphError,
  );
});

test('addEdge: throws GraphError when to is missing', () => {
  const g = new Graph();
  assert.throws(
    () => g.addEdge({ from: nodeId('screen', 'S'), type: 'RENDERS', grade: 'EXACT' }),
    GraphError,
  );
});

test('addEdge: throws GraphError when an endpoint id has an unknown kind prefix', () => {
  const g = new Graph();
  assert.throws(
    () => g.addEdge({ from: 'widget:x', to: nodeId('endpoint', 'E'), type: 'RENDERS', grade: 'EXACT' }),
    GraphError,
  );
});

// ---------------------------------------------------------------------------
// buildGraph — the three fact shapes
// ---------------------------------------------------------------------------

test('buildGraph: a node fact adds a node and drops the fact field', () => {
  const id = nodeId('table', 'main.T');
  const g = buildGraph([{ fact: 'node', id, name: 'T' }]);
  const n = g.nodes.get(id);
  assert.ok(n);
  assert.equal(n.name, 'T');
  assert.equal(n.fact, undefined);
});

test('buildGraph: an edge fact adds a structural edge with the asserted grade', () => {
  const from = nodeId('statement', 'ST');
  const to = nodeId('table', 'main.T');
  const g = buildGraph([{ fact: 'edge', from, to, type: 'EXECUTES', grade: 'EXACT' }]);
  const outEdges = g._out.get(from);
  assert.equal(outEdges.length, 1);
  assert.equal(outEdges[0].type, 'EXECUTES');
  assert.equal(outEdges[0].grade, 'EXACT');
});

test('buildGraph: a call fact with static+resolved evidence classifies to CALLS/EXACT', () => {
  const from = nodeId('symbol', 'A');
  const to = nodeId('symbol', 'B');
  const g = buildGraph([
    { fact: 'call', from, to, evidence: { callKind: 'static', binding: 'resolved' } },
  ]);
  const outEdges = g._out.get(from);
  assert.equal(outEdges.length, 1);
  assert.equal(outEdges[0].type, 'CALLS');
  assert.equal(outEdges[0].grade, 'EXACT');
});

test('Invariant I-1: a call fact with interface+single-candidate evidence classifies to MAY_CALL/SOUND_SET, never CALLS/EXACT', () => {
  const from = nodeId('symbol', 'A');
  const to = nodeId('symbol', 'B');
  const g = buildGraph([
    { fact: 'call', from, to, evidence: { callKind: 'interface', candidateCount: 1, binding: 'resolved' } },
  ]);
  const outEdges = g._out.get(from);
  assert.equal(outEdges.length, 1);
  assert.equal(outEdges[0].type, 'MAY_CALL');
  assert.equal(outEdges[0].grade, 'SOUND_SET');
  assert.notEqual(outEdges[0].type, 'CALLS');
  assert.notEqual(outEdges[0].grade, 'EXACT');
});

test('buildGraph: throws GraphError on a fact with an unknown fact shape', () => {
  assert.throws(() => buildGraph([{ fact: 'widget' }]), GraphError);
});

test('buildGraph: throws GraphError when facts is not an array', () => {
  assert.throws(() => buildGraph({ fact: 'node', id: nodeId('table', 'T') }), GraphError);
});

// ---------------------------------------------------------------------------
// reach / impactOf
// ---------------------------------------------------------------------------

/**
 * Build the chain graph used across reach/impactOf tests:
 *   screen:S -RENDERS(EXACT)-> endpoint:E -HANDLES(EXACT)-> symbol:SVC
 *   symbol:SVC -(call, interface candidateCount 1)-> symbol:IMPL   (MAY_CALL/SOUND_SET)
 *   symbol:IMPL -IMPLEMENTS_STMT(EXACT)-> statement:ST -EXECUTES(EXACT)-> table:T
 *   statement:ST -WRITES(EXACT)-> column:T.C
 */
function buildChainGraph() {
  const S = nodeId('screen', 'S');
  const E = nodeId('endpoint', 'E');
  const SVC = nodeId('symbol', 'SVC');
  const IMPL = nodeId('symbol', 'IMPL');
  const ST = nodeId('statement', 'ST');
  const T = nodeId('table', 'T');
  const C = nodeId('column', 'T.C');

  const facts = [
    { fact: 'edge', from: S, to: E, type: 'RENDERS', grade: 'EXACT' },
    { fact: 'edge', from: E, to: SVC, type: 'HANDLES', grade: 'EXACT' },
    { fact: 'call', from: SVC, to: IMPL, evidence: { callKind: 'interface', candidateCount: 1, binding: 'resolved' } },
    { fact: 'edge', from: IMPL, to: ST, type: 'IMPLEMENTS_STMT', grade: 'EXACT' },
    { fact: 'edge', from: ST, to: T, type: 'EXECUTES', grade: 'EXACT' },
    { fact: 'edge', from: ST, to: C, type: 'WRITES', grade: 'EXACT' },
  ];
  const g = buildGraph(facts);
  return { g, S, E, SVC, IMPL, ST, T, C };
}

test('reach: forward conservative reach from screen:S reaches column:T.C', () => {
  const { g, S, C } = buildChainGraph();
  const result = g.reach(S, { direction: 'out', mode: 'conservative' });
  assert.ok(result.has(C), 'expected column:T.C to be reached');
});

test('reach: weakest link — the path to column:T.C carries pathGrade SOUND_SET, not EXACT', () => {
  const { g, S, C } = buildChainGraph();
  const result = g.reach(S, { direction: 'out', mode: 'conservative' });
  const entry = result.get(C);
  assert.equal(entry.pathGrade, 'SOUND_SET');
  assert.notEqual(entry.pathGrade, 'EXACT');
});

test('reach: the reached entry has a positive numeric hops count', () => {
  const { g, S, C } = buildChainGraph();
  const result = g.reach(S, { direction: 'out', mode: 'conservative' });
  const entry = result.get(C);
  assert.equal(typeof entry.hops, 'number');
  assert.ok(entry.hops > 0);
});

test('reach: strict mode does NOT reach column:T.C because the interface call edge is excluded', () => {
  const { g, S, C } = buildChainGraph();
  const result = g.reach(S, { direction: 'out', mode: 'strict' });
  assert.equal(result.has(C), false);
});

test('impactOf: backward conservative reach from column:T.C reaches screen:S', () => {
  const { g, S, C } = buildChainGraph();
  const result = g.impactOf(C, { mode: 'conservative' });
  assert.ok(result.has(S), 'expected screen:S to be reached via impactOf');
});

test('reach: a path made entirely of EXACT edges yields pathGrade EXACT', () => {
  const S = nodeId('screen', 'S2');
  const E = nodeId('endpoint', 'E2');
  const SVC = nodeId('symbol', 'SVC2');
  const g = buildGraph([
    { fact: 'edge', from: S, to: E, type: 'RENDERS', grade: 'EXACT' },
    { fact: 'edge', from: E, to: SVC, type: 'HANDLES', grade: 'EXACT' },
  ]);
  const result = g.reach(S, { direction: 'out', mode: 'conservative' });
  const entry = result.get(SVC);
  assert.equal(entry.pathGrade, 'EXACT');
});

test('reach: maxHops bounds the search to only the direct neighbor', () => {
  const { g, S, E, SVC } = buildChainGraph();
  const result = g.reach(S, { direction: 'out', mode: 'conservative', maxHops: 1 });
  assert.ok(result.has(E), 'direct neighbor endpoint:E should be reached');
  assert.equal(result.has(SVC), false, 'deeper node symbol:SVC should not be reached with maxHops 1');
});

test('reach: edgeTypes filter restricts traversal to only the listed edge types', () => {
  const { g, S, E, SVC } = buildChainGraph();
  const result = g.reach(S, { direction: 'out', mode: 'conservative', edgeTypes: ['RENDERS'] });
  assert.ok(result.has(E), 'endpoint:E should be reached via RENDERS');
  assert.equal(result.has(SVC), false, 'symbol:SVC should not be reached when only RENDERS is allowed');
});

test('reach: throws GraphError on an unknown mode', () => {
  const { g, S } = buildChainGraph();
  assert.throws(() => g.reach(S, { mode: 'lax' }), GraphError);
});

test('reach: throws GraphError when the start node is not in the graph', () => {
  const { g } = buildChainGraph();
  assert.throws(() => g.reach(nodeId('screen', 'NOPE'), {}), GraphError);
});

test('Graph.ids: returns a sorted array of reached ids', () => {
  const { g, S } = buildChainGraph();
  const result = g.reach(S, { direction: 'out', mode: 'conservative' });
  const ids = Graph.ids(result);
  const sorted = [...ids].sort();
  assert.deepEqual(ids, sorted);
  assert.ok(ids.length > 0);
});

// ---------------------------------------------------------------------------
// adjacency accessors + reach().via (the walk's back-pointer)
// ---------------------------------------------------------------------------

test('reach: every reached entry carries via — the index of an edge whose `to` IS that node', () => {
  const { g, S } = buildChainGraph();
  const result = g.reach(S, { direction: 'out', mode: 'conservative' });
  assert.ok(result.size > 0);
  for (const [id, rec] of result) {
    assert.equal(typeof rec.via, 'number', `${id} should carry a via edge index`);
    const edge = g.edgeAt(rec.via);
    assert.ok(edge, `via ${rec.via} should address a real edge`);
    assert.equal(edge.to, id, `via edge of ${id} must end at ${id}`);
  }
});

test('outEdges/inEdges: return the adjacency of a node, empty array when it has none', () => {
  const { g, S, E, SVC } = buildChainGraph();
  const out = g.outEdges(S);
  assert.equal(out.length, 1);
  assert.equal(out[0].to, E);
  assert.equal(out[0].type, 'RENDERS');
  assert.equal(typeof out[0].idx, 'number');
  assert.deepEqual(g.inEdges(S), []);            // nothing points at the screen
  assert.equal(g.outEdges(nodeId('table', 'NOPE')).length, 0); // unknown node → empty
  assert.equal(g.inEdges(SVC)[0].from, E);
});

test('edgeAt: resolves an adjacency idx back to the full edge record (with evidence)', () => {
  const { g, SVC, IMPL } = buildChainGraph();
  const adj = g.outEdges(SVC).find((e) => e.to === IMPL);
  const edge = g.edgeAt(adj.idx);
  assert.equal(edge.from, SVC);
  assert.equal(edge.to, IMPL);
  assert.equal(edge.type, 'MAY_CALL');
  assert.equal(edge.grade, 'SOUND_SET');
  assert.equal(edge.evidence.callKind, 'interface'); // adjacency omits evidence; edgeAt has it
});

// ---------------------------------------------------------------------------
// GRADE_SETS / EDGE_TYPES / NODE_KINDS sanity (exported constants)
// ---------------------------------------------------------------------------

test('GRADE_SETS: strict/conservative/heuristic form a strictly widening set', () => {
  assert.deepEqual([...GRADE_SETS.strict], ['EXACT']);
  for (const grade of GRADE_SETS.strict) assert.ok(GRADE_SETS.conservative.has(grade));
  for (const grade of GRADE_SETS.conservative) assert.ok(GRADE_SETS.heuristic.has(grade));
});

test('EDGE_TYPES and NODE_KINDS are frozen arrays', () => {
  assert.ok(Object.isFrozen(EDGE_TYPES));
  assert.ok(Object.isFrozen(NODE_KINDS));
});
