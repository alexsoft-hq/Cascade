import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Graph, nodeId } from '../src/core/graph.mjs';
import { buildGraphFromSql } from '../src/adapters/sql_bridge.mjs';
import { projectPack, loadPack, PACK_SCHEMA, PackError } from '../src/core/pack.mjs';

// ---------------------------------------------------------------------------
// Fixture — small inline catalog/lineage records (mirrors the shape used by
// test/sql_bridge.test.mjs and test/tools.test.mjs): table pms_product with
// columns id/name/price; an update (writes price,name; reads id), a select
// (reads id,name,price), and a delete (touches the table, reads id, writes
// no columns).
// ---------------------------------------------------------------------------

function catalogRecords() {
  return [
    { kind: 'table', schema: null, table: 'pms_product', comment: 'product table' },
    { kind: 'column', schema: null, table: 'pms_product', column: 'id', type: 'INT', comment: null },
    { kind: 'column', schema: null, table: 'pms_product', column: 'name', type: 'VARCHAR(100)', comment: null },
    { kind: 'column', schema: null, table: 'pms_product', column: 'price', type: 'DECIMAL(10,2)', comment: null },
  ];
}

function lineageRecords() {
  return [
    {
      kind: 'lineage', namespace: 'PmsProductMapper', id: 'updateByPrimaryKey', type: 'update',
      tables: [{ table: 'pms_product', access: 'write' }],
      columns: [
        { table: 'pms_product', column: 'price', access: 'write' },
        { table: 'pms_product', column: 'name', access: 'write' },
        { table: 'pms_product', column: 'id', access: 'read' },
      ],
      file: 'PmsProductMapper.xml', line: 10,
    },
    {
      kind: 'lineage', namespace: 'PmsProductMapper', id: 'selectByPrimaryKey', type: 'select',
      tables: [{ table: 'pms_product', access: 'read' }],
      columns: [
        { table: 'pms_product', column: 'id', access: 'read' },
        { table: 'pms_product', column: 'name', access: 'read' },
        { table: 'pms_product', column: 'price', access: 'read' },
      ],
      file: 'PmsProductMapper.xml', line: 30,
    },
    {
      kind: 'lineage', namespace: 'PmsProductMapper', id: 'deleteByPrimaryKey', type: 'delete',
      tables: [{ table: 'pms_product', access: 'delete' }],
      columns: [{ table: 'pms_product', column: 'id', access: 'read' }],
      file: 'PmsProductMapper.xml', line: 50,
    },
  ];
}

function buildFixtureGraph() {
  return buildGraphFromSql(catalogRecords(), lineageRecords());
}

// ---------------------------------------------------------------------------
// projectPack — shape
// ---------------------------------------------------------------------------

test('projectPack: returns {schema, meta, nodes, edges, counts, digest}', () => {
  const g = buildFixtureGraph();
  const pack = projectPack(g, { builtAt: 'A' });
  assert.equal(pack.schema, PACK_SCHEMA);
  assert.deepEqual(pack.meta, { builtAt: 'A' });
  assert.ok(Array.isArray(pack.nodes));
  assert.ok(Array.isArray(pack.edges));
  assert.equal(typeof pack.digest, 'string');
  assert.ok(pack.digest.length > 0);
});

test('projectPack: counts.nodes and counts.edges match the graph', () => {
  const g = buildFixtureGraph();
  const pack = projectPack(g);
  assert.equal(pack.counts.nodes, g.nodes.size);
  assert.equal(pack.counts.edges, g.edges.length);
  assert.equal(pack.nodes.length, g.nodes.size);
  assert.equal(pack.edges.length, g.edges.length);
});

test('projectPack: throws PackError when given something that is not a Graph', () => {
  assert.throws(() => projectPack({ nodes: new Map(), edges: [] }), PackError);
});

// ---------------------------------------------------------------------------
// Digest excludes meta
// ---------------------------------------------------------------------------

test('digest excludes meta: two projections of the same graph with different builtAt share the same digest', () => {
  const g = buildFixtureGraph();
  const packA = projectPack(g, { builtAt: 'A' });
  const packB = projectPack(g, { builtAt: 'B' });
  assert.notEqual(packA.meta.builtAt, packB.meta.builtAt);
  assert.equal(packA.digest, packB.digest);
});

test('digest excludes meta: a graph with an extra edge produces a different digest', () => {
  const g = buildFixtureGraph();
  const packBase = projectPack(g, { builtAt: 'A' });

  // Clone via round-trip, then add one more fact (a new stub column read by
  // the select statement) so nodes+edges genuinely differ.
  const g2 = loadPack(packBase);
  g2.addEdge({
    from: nodeId('statement', 'PmsProductMapper.selectByPrimaryKey'),
    to: nodeId('column', 'pms_product.sku'),
    type: 'READS',
    grade: 'EXACT',
  });
  const packVariant = projectPack(g2, { builtAt: 'A' }); // same meta as packBase

  assert.notEqual(packVariant.digest, packBase.digest);
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test('determinism: projectPack called twice on the same graph yields deep-equal nodes/edges arrays', () => {
  const g = buildFixtureGraph();
  const pack1 = projectPack(g, { builtAt: 'A' });
  const pack2 = projectPack(g, { builtAt: 'A' });
  assert.deepEqual(pack1.nodes, pack2.nodes);
  assert.deepEqual(pack1.edges, pack2.edges);
  assert.equal(pack1.digest, pack2.digest);
});

test('determinism: nodes are sorted by id ascending', () => {
  const g = buildFixtureGraph();
  const pack = projectPack(g);
  const ids = pack.nodes.map((n) => n.id);
  const sorted = [...ids].sort();
  assert.deepEqual(ids, sorted);
});

test('determinism: edges are sorted by (from, to, type) ascending', () => {
  const g = buildFixtureGraph();
  const pack = projectPack(g);
  for (let i = 1; i < pack.edges.length; i++) {
    const a = pack.edges[i - 1];
    const b = pack.edges[i];
    const key = (e) => e.from + " " + e.to + " " + e.type;
    assert.ok(key(a) <= key(b), `edge order violated between index ${i - 1} and ${i}`);
  }
  assert.ok(pack.edges.length > 0, 'expected at least one edge to check ordering');
});

// ---------------------------------------------------------------------------
// loadPack round-trip
// ---------------------------------------------------------------------------

test('loadPack: round-trips to a Graph with the same node count and edge count', () => {
  const g = buildFixtureGraph();
  const loaded = loadPack(projectPack(g));
  assert.equal(loaded.nodes.size, g.nodes.size);
  assert.equal(loaded.edges.length, g.edges.length);
});

test('loadPack: round-tripped graph answers a direct edge check the same as the original', () => {
  const g = buildFixtureGraph();
  const loaded = loadPack(projectPack(g));
  const sid = nodeId('statement', 'PmsProductMapper.updateByPrimaryKey');
  const cid = nodeId('column', 'pms_product.price');
  const origEdge = g.edges.find((e) => e.type === 'WRITES' && e.from === sid && e.to === cid);
  const loadedEdge = loaded.edges.find((e) => e.type === 'WRITES' && e.from === sid && e.to === cid);
  assert.ok(origEdge, 'expected WRITES edge in the original graph');
  assert.ok(loadedEdge, 'expected WRITES edge in the round-tripped graph');
  assert.equal(loadedEdge.grade, origEdge.grade);
});

test('loadPack: round-tripped graph answers a reach() query the same as the original', () => {
  const g = buildFixtureGraph();
  const loaded = loadPack(projectPack(g));
  const cid = nodeId('column', 'pms_product.price');
  const origReach = Graph.ids(g.reach(cid, { direction: 'in', mode: 'strict' }));
  const loadedReach = Graph.ids(loaded.reach(cid, { direction: 'in', mode: 'strict' }));
  assert.deepEqual(loadedReach, origReach);
  assert.ok(origReach.length > 0, 'expected the fixture to have at least one backward-reachable statement');
});

// ---------------------------------------------------------------------------
// loadPack validation
// ---------------------------------------------------------------------------

test('loadPack: throws PackError on a wrong schema', () => {
  assert.throws(() => loadPack({ schema: 'not:a:pack', nodes: [], edges: [] }), PackError);
});

test('loadPack: throws PackError on a missing schema', () => {
  assert.throws(() => loadPack({ nodes: [], edges: [] }), PackError);
});

test('loadPack: throws PackError when pack.nodes is not an array', () => {
  assert.throws(() => loadPack({ schema: PACK_SCHEMA, nodes: 'nope', edges: [] }), PackError);
});

test('loadPack: throws PackError when pack.edges is not an array', () => {
  assert.throws(() => loadPack({ schema: PACK_SCHEMA, nodes: [], edges: 'nope' }), PackError);
});

// ---------------------------------------------------------------------------
// Digest verification / tamper detection
// ---------------------------------------------------------------------------

test('loadPack({verifyDigest:true}): passes on an untampered pack', () => {
  const g = buildFixtureGraph();
  const pack = projectPack(g);
  const loaded = loadPack(pack, { verifyDigest: true });
  assert.equal(loaded.nodes.size, g.nodes.size);
});

test('loadPack({verifyDigest:true}): throws PackError when pack.nodes is mutated but digest is stale', () => {
  const g = buildFixtureGraph();
  const pack = projectPack(g);
  const tampered = { ...pack, nodes: [...pack.nodes, { id: 'table:evil', kind: 'table' }] };
  assert.throws(() => loadPack(tampered, { verifyDigest: true }), PackError);
});

test('loadPack({verifyDigest:true}): throws PackError when pack.edges is mutated but digest is stale', () => {
  const g = buildFixtureGraph();
  const pack = projectPack(g);
  const evilEdge = { from: pack.nodes[0].id, to: pack.nodes[0].id, type: 'DECLARES', grade: 'EXACT' };
  const tampered = { ...pack, edges: [...pack.edges, evilEdge] };
  assert.throws(() => loadPack(tampered, { verifyDigest: true }), PackError);
});

test('loadPack without verifyDigest does NOT check the digest (a tampered pack still loads)', () => {
  const g = buildFixtureGraph();
  const pack = projectPack(g);
  const tampered = { ...pack, nodes: [...pack.nodes, { id: 'table:evil', kind: 'table' }] };
  assert.doesNotThrow(() => loadPack(tampered));
});
