import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  hopsFrom, ringPlan, ringLayout, hopRingLabel, nameFamily, familyCounts, familyPalette, witnessWidth,
  connectedComponents, shelfPack, seededRandom, settleComponents,
} from '../src/viewer/graphlayout.mjs';
import { handleViewerLib } from '../src/mcp/http.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// hopsFrom — the ring a node lands on
// ---------------------------------------------------------------------------

const E = (from, to) => ({ from, to });

test('hopsFrom: the focus is hop 0', () => {
  assert.equal(hopsFrom('a', [E('a', 'b')]).get('a'), 0);
});

test('hopsFrom: walks edges in BOTH directions (the picture is undirected)', () => {
  const h = hopsFrom('b', [E('a', 'b'), E('b', 'c')]);
  assert.equal(h.get('a'), 1);
  assert.equal(h.get('c'), 1);
});

test('hopsFrom: takes the SHORTEST path, whatever order the edges arrive in', () => {
  // a→b→c→d is three hops; the direct a–d edge, listed last, makes it one.
  const h = hopsFrom('a', [E('a', 'b'), E('b', 'c'), E('c', 'd'), E('a', 'd')]);
  assert.equal(h.get('d'), 1);
  assert.equal(h.get('c'), 2);
});

test('hopsFrom: a node the edges never reach gets NO entry (it is not hop 0)', () => {
  const h = hopsFrom('a', [E('a', 'b'), E('x', 'y')]);
  assert.equal(h.has('x'), false);
  assert.equal(h.get('b'), 1);
});

test('hopsFrom: no edges at all still places the focus', () => {
  const h = hopsFrom('a', []);
  assert.deepEqual([...h.entries()], [['a', 0]]);
});

test('hopsFrom: a self-edge does not loop forever', () => {
  const h = hopsFrom('a', [E('a', 'a'), E('a', 'b')]);
  assert.equal(h.get('a'), 0);
  assert.equal(h.get('b'), 1);
});

// The neighborhood tool collects nodes by DIRECTION but hands back every edge
// between the nodes it collected. An undirected BFS therefore finds shortcuts the
// walk never took, and the rings then claim a distance nobody measured.
test("hopsFrom: direction 'up' walks AGAINST the arrow", () => {
  // a → b → c: from c, going up, a is two steps away and b one.
  const h = hopsFrom('c', [E('a', 'b'), E('b', 'c')], 'up');
  assert.equal(h.get('b'), 1);
  assert.equal(h.get('a'), 2);
});

test("hopsFrom: direction 'down' follows the arrow, and does not walk back up it", () => {
  const h = hopsFrom('a', [E('a', 'b'), E('c', 'a')], 'down');
  assert.equal(h.get('b'), 1);
  assert.equal(h.has('c'), false, 'c points AT a; a down walk never reaches it');
});

test("hopsFrom: 'both' (the default) is the undirected walk, as before", () => {
  const edges = [E('a', 'b'), E('c', 'a')];
  assert.deepEqual([...hopsFrom('a', edges, 'both')], [...hopsFrom('a', edges)]);
  assert.equal(hopsFrom('a', edges).get('c'), 1);
});

test('hopsFrom: a DOWN edge in an up answer is not a shortcut for the up walk', () => {
  // The up chain from f is c → b → a → f, three steps. The answer also carries
  // f → c, because that edge joins two nodes it collected — undirected, that puts
  // a three-step node on ring 1.
  const edges = [E('a', 'f'), E('b', 'a'), E('c', 'b'), E('f', 'c')];
  assert.equal(hopsFrom('f', edges).get('c'), 1, 'undirected takes the shortcut');
  assert.equal(hopsFrom('f', edges, 'up').get('c'), 3, 'the up walk needed three steps');
});

// ---------------------------------------------------------------------------
// ringPlan — where each ring sits
// ---------------------------------------------------------------------------

test('ringPlan: hop 0 sits at the centre', () => {
  const p = ringPlan(new Map([[0, 1], [1, 3]]), { step: 100 });
  assert.deepEqual(p[0], { hop: 0, count: 1, radius: 0 });
});

test('ringPlan: a sparse ring sits at hop × step', () => {
  const p = ringPlan(new Map([[0, 1], [1, 2], [2, 2]]), { step: 100, gap: 10, nodeR: 5 });
  assert.equal(p[1].radius, 100);
  assert.equal(p[2].radius, 200);
});

test('ringPlan: a crowded OUTER ring pushes the inner ones out too — no dot in a moat', () => {
  // hop 1 would sit at 100 while hop 2 is shoved to ~536 by its own count: the
  // inner ring is spread over the radius the picture already takes.
  const p = ringPlan(new Map([[0, 1], [1, 23], [2, 102]]), { step: 100, gap: 15, nodeR: 9 });
  assert.ok(p[2].radius > 500, 'outer was ' + p[2].radius);
  assert.ok(Math.abs(p[1].radius - p[2].radius / 2) < 1e-9, 'inner was ' + p[1].radius);
});

test('ringPlan: the evening pass never pulls a ring INWARD', () => {
  const p = ringPlan(new Map([[0, 1], [1, 90], [2, 2]]), { step: 100, gap: 14, nodeR: 7 });
  assert.ok(p[1].radius > 400, 'the crowded inner ring keeps its own radius: ' + p[1].radius);
  assert.ok(p[2].radius >= p[1].radius + 100);
});

test('ringPlan: a CROWDED ring is pushed out until its own nodes fit around it', () => {
  // 90 nodes × (2·7 + 14 = 28px) = 2520px of circumference -> r ≈ 401
  const p = ringPlan(new Map([[0, 1], [1, 90]]), { step: 100, gap: 14, nodeR: 7 });
  assert.ok(p[1].radius > 400 && p[1].radius < 402, 'radius was ' + p[1].radius);
});

test('ringPlan: rings never cross — each is at least `step` outside the one inside it', () => {
  const p = ringPlan(new Map([[0, 1], [1, 90], [2, 3]]), { step: 100, gap: 14, nodeR: 7 });
  assert.ok(p[2].radius >= p[1].radius + 100, `${p[2].radius} vs ${p[1].radius}`);
});

test('ringPlan: rings come back in hop order however the map was built', () => {
  const p = ringPlan(new Map([[2, 1], [0, 1], [1, 1]]), { step: 50 });
  assert.deepEqual(p.map((x) => x.hop), [0, 1, 2]);
});

test('ringPlan: hops are ordered as NUMBERS — hop 10 is outside hop 2, not inside it', () => {
  // A default (string) sort gives 0, 1, 10, 11, 2, and the "each ring is `step`
  // outside the last" floor then hands hop 2 a radius bigger than hop 11's.
  const p = ringPlan(new Map([[0, 1], [1, 1], [2, 1], [10, 1], [11, 1]]), { step: 100 });
  assert.deepEqual(p.map((x) => x.hop), [0, 1, 2, 10, 11]);
  assert.deepEqual(p.map((x) => x.radius), [0, 100, 200, 1000, 1100]);
});

// ---------------------------------------------------------------------------
// ringLayout — the positions themselves
// ---------------------------------------------------------------------------

const hopMap = (o) => (id) => o[id];

test('ringLayout: the focus lands exactly on the centre', () => {
  const { nodes } = ringLayout(['f', 'a'], hopMap({ f: 0, a: 1 }), { cx: 300, cy: 200, step: 100 });
  const f = nodes.find((n) => n.id === 'f');
  assert.equal(f.x, 300);
  assert.equal(f.y, 200);
  assert.equal(f.radius, 0);
});

test('ringLayout: every node of a ring is exactly that ring away from the centre', () => {
  const { nodes, plan } = ringLayout(['f', 'a', 'b', 'c'], hopMap({ f: 0, a: 1, b: 1, c: 2 }),
    { cx: 0, cy: 0, step: 100, gap: 10, nodeR: 5 });
  const r1 = plan.find((p) => p.hop === 1).radius;
  for (const n of nodes.filter((x) => x.hop === 1)) {
    assert.ok(Math.abs(Math.hypot(n.x, n.y) - r1) < 1e-9, `${n.id} at ${Math.hypot(n.x, n.y)} not ${r1}`);
  }
});

test('ringLayout: a ring spreads its nodes evenly (n nodes, 2π/n apart)', () => {
  const { nodes } = ringLayout(['a', 'b', 'c', 'd'], () => 1, { step: 100 });
  const angs = nodes.map((n) => n.angle);
  for (let i = 1; i < angs.length; i++) {
    assert.ok(Math.abs((angs[i] - angs[i - 1]) - (Math.PI / 2)) < 1e-9);
  }
});

test('ringLayout: neighbouring rings are rotated so their spokes do not line up', () => {
  const { nodes } = ringLayout(['a', 'b'], hopMap({ a: 1, b: 2 }), { step: 100 });
  assert.notEqual(nodes[0].angle, nodes[1].angle);
});

test('ringLayout: deterministic — the same input gives byte-identical positions', () => {
  const ids = ['f', 'a', 'b', 'c', 'd'];
  const h = hopMap({ f: 0, a: 1, b: 1, c: 2, d: 2 });
  const one = ringLayout(ids, h, { cx: 10, cy: 20, step: 90 });
  const two = ringLayout(ids, h, { cx: 10, cy: 20, step: 90 });
  assert.deepEqual(one, two);
});

test('ringLayout: an empty picture is an empty layout, not a crash', () => {
  const { nodes, plan } = ringLayout([], () => 0, {});
  assert.deepEqual(nodes, []);
  assert.deepEqual(plan, []);
});

// ---------------------------------------------------------------------------
// hopRingLabel — the parking ring is not a hop
// ---------------------------------------------------------------------------

test('hopRingLabel: a measured ring is named by its hop and its count', () => {
  assert.equal(hopRingLabel(2, 9), 'hop 2  (9)');
  assert.equal(hopRingLabel(0, 1), 'hop 0  (1)');
});

test('hopRingLabel: the ring unreached nodes are PARKED on says so, never "hop N"', () => {
  assert.equal(hopRingLabel(3, 2, 3), 'unreached  (2)');
  assert.equal(hopRingLabel(3, null, 3), 'unreached');
  assert.equal(hopRingLabel(2, 9, 3), 'hop 2  (9)', 'the real rings are untouched');
});

test('hopRingLabel: with no parking ring every ring is a hop — including hop 0', () => {
  assert.equal(hopRingLabel(0, 1, null), 'hop 0  (1)');
  assert.equal(hopRingLabel(1, 4), 'hop 1  (4)');
});

// ---------------------------------------------------------------------------
// nameFamily / familyCounts / familyPalette
// ---------------------------------------------------------------------------

test('nameFamily: the token before the first underscore', () => {
  assert.equal(nameFamily('pms_product'), 'pms');
  assert.equal(nameFamily('ums_role_resource_relation'), 'ums');
});

test('nameFamily: a name with no underscore has NO family (null, not itself)', () => {
  assert.equal(nameFamily('customers'), null);
});

test('nameFamily: a leading underscore is not a family', () => {
  assert.equal(nameFamily('_hidden'), null);
});

test('familyCounts: biggest family first, ties alphabetically', () => {
  const rows = familyCounts(['pms_a', 'pms_b', 'pms_c', 'ums_a', 'ums_b', 'cms_a', 'oms_a']);
  assert.deepEqual(rows, [
    { family: 'pms', count: 3 },
    { family: 'ums', count: 2 },
    { family: 'cms', count: 1 },
    { family: 'oms', count: 1 },
  ]);
});

test('familyCounts: the family-less names are counted together and come LAST', () => {
  const rows = familyCounts(['orders', 'users', 'items', 'pms_a']);
  assert.deepEqual(rows, [{ family: 'pms', count: 1 }, { family: null, count: 3 }]);
});

test('familyCounts: a schema with no underscores at all yields one null family', () => {
  assert.deepEqual(familyCounts(['orders', 'users']), [{ family: null, count: 2 }]);
});

test('familyPalette: families take colours in the order given', () => {
  const p = familyPalette(['pms', 'ums'], ['#a', '#b', '#c']);
  assert.equal(p.get('pms'), '#a');
  assert.equal(p.get('ums'), '#b');
});

test('familyPalette: more families than colours repeats the palette', () => {
  const p = familyPalette(['a', 'b', 'c'], ['#1', '#2']);
  assert.equal(p.get('c'), '#1');
});

test('familyPalette: an empty palette maps nothing rather than throwing', () => {
  assert.equal(familyPalette(['a'], []).size, 0);
});

// ---------------------------------------------------------------------------
// witnessWidth
// ---------------------------------------------------------------------------

test('witnessWidth: one witness is the thinnest line, the top witness the thickest', () => {
  assert.equal(witnessWidth(1, 3), 1);
  assert.equal(witnessWidth(3, 3), 3);
  assert.equal(witnessWidth(2, 3), 2);
});

test('witnessWidth: when every edge has one witness there is nothing to scale', () => {
  assert.equal(witnessWidth(1, 1), 1);
});

test('witnessWidth: a count outside the range is clamped, never drawn thicker than max', () => {
  assert.equal(witnessWidth(99, 3), 3);
  assert.equal(witnessWidth(0, 3), 1);
});

// ---------------------------------------------------------------------------
// connectedComponents — which nodes the drawn edges tie together
// ---------------------------------------------------------------------------

test('connectedComponents: edges tie nodes into one component, both directions', () => {
  const c = connectedComponents(['a', 'b', 'c'], [E('a', 'b'), E('c', 'b')]);
  assert.deepEqual(c, [['a', 'b', 'c']]);
});

test('connectedComponents: a node no drawn edge touches is its own component', () => {
  assert.deepEqual(connectedComponents(['a', 'b', 'x'], [E('a', 'b')]), [['a', 'b'], ['x']]);
});

test('connectedComponents: no edges at all — every node stands alone', () => {
  assert.deepEqual(connectedComponents(['a', 'b'], []), [['a'], ['b']]);
});

test('connectedComponents: components, and members, keep the input order', () => {
  const c = connectedComponents(['z', 'y', 'x'], [E('x', 'z')]);
  assert.deepEqual(c, [['z', 'x'], ['y']]);
});

test('connectedComponents: members keep the INPUT order, not the order BFS found them', () => {
  // BFS from a reaches c first (a–c), then b through c. The documented order is
  // the input's: without the re-sort this comes back [['a', 'c', 'b']].
  assert.deepEqual(connectedComponents(['a', 'b', 'c'], [E('a', 'c'), E('c', 'b')]), [['a', 'b', 'c']]);
  // and the same set of edges given the other way round agrees
  assert.deepEqual(connectedComponents(['a', 'b', 'c'], [E('c', 'b'), E('a', 'c')]), [['a', 'b', 'c']]);
});

test('connectedComponents: order of the EDGES does not change the answer', () => {
  const ids = ['a', 'b', 'c', 'd'];
  const e1 = [E('a', 'b'), E('c', 'd'), E('b', 'c')];
  const e2 = [E('b', 'c'), E('c', 'd'), E('a', 'b')];
  assert.deepEqual(connectedComponents(ids, e1), connectedComponents(ids, e2));
  assert.deepEqual(connectedComponents(ids, e1), [['a', 'b', 'c', 'd']]);
});

test('connectedComponents: a self-edge and an edge to an unknown id are ignored', () => {
  assert.deepEqual(connectedComponents(['a', 'b'], [E('a', 'a'), E('a', 'ghost')]), [['a'], ['b']]);
});

test('connectedComponents: an id repeated in the input is visited once', () => {
  assert.deepEqual(connectedComponents(['a', 'a', 'b'], [E('a', 'b')]), [['a', 'b']]);
});

test('connectedComponents: a long chain does not blow the stack', () => {
  const ids = Array.from({ length: 20000 }, (_, i) => 'n' + i);
  const edges = ids.slice(1).map((id, i) => E(ids[i], id));
  const c = connectedComponents(ids, edges);
  assert.equal(c.length, 1);
  assert.equal(c[0].length, 20000);
});

// ---------------------------------------------------------------------------
// shelfPack — the boxes side by side instead of scattered
// ---------------------------------------------------------------------------

// A packed box already spans its nodes' full extent (centres plus radii), so
// two boxes clash the moment their rectangles intersect at all.
const overlaps = (placed) => {
  let n = 0;
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i], b = placed[j];
      if (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y) n++;
    }
  }
  return n;
};

test('shelfPack: nothing in, nothing out', () => {
  assert.deepEqual(shelfPack([]), { placed: [], width: 0, height: 0 });
});

test('shelfPack: one box sits at the origin and the block is exactly its size', () => {
  const r = shelfPack([{ key: 'a', w: 100, h: 40 }]);
  assert.deepEqual(r.placed, [{ key: 'a', x: 0, y: 0, w: 100, h: 40 }]);
  assert.equal(r.width, 100);
  assert.equal(r.height, 40);
});

test('shelfPack: the biggest box is placed first, whatever order it arrives in', () => {
  const r = shelfPack([{ key: 'small', w: 10, h: 10 }, { key: 'big', w: 200, h: 200 }], { gap: 10 });
  assert.equal(r.placed[0].key, 'big');
  assert.equal(r.placed[0].x, 0);
});

test('shelfPack: no two packed boxes overlap', () => {
  const boxes = Array.from({ length: 40 }, (_, i) => ({ key: i, w: 30 + (i * 37) % 200, h: 20 + (i * 53) % 150, maxR: i % 7 }));
  const r = shelfPack(boxes, { aspect: 1.7, gap: 24 });
  assert.equal(overlaps(r.placed), 0);
});

test('shelfPack: the block comes out roughly the aspect it was asked for', () => {
  const boxes = Array.from({ length: 30 }, (_, i) => ({ key: i, w: 100, h: 100 }));
  const wide = shelfPack(boxes, { aspect: 2, gap: 10 });
  const tall = shelfPack(boxes, { aspect: 0.5, gap: 10 });
  assert.ok(wide.width / wide.height > tall.width / tall.height,
    `aspect 2 (${wide.width}x${wide.height}) should be wider than aspect 0.5 (${tall.width}x${tall.height})`);
  assert.ok(wide.width / wide.height > 1.2 && wide.width / wide.height < 3.5);
});

test('shelfPack: the gap between neighbours grows with the fatter box\'s node radius', () => {
  const thin = shelfPack([{ key: 'a', w: 50, h: 50, maxR: 0 }, { key: 'b', w: 50, h: 50, maxR: 0 }], { aspect: 4, gap: 24 });
  const fat = shelfPack([{ key: 'a', w: 50, h: 50, maxR: 0 }, { key: 'b', w: 50, h: 50, maxR: 30 }], { aspect: 4, gap: 24 });
  assert.equal(thin.placed[1].x, 74);
  assert.equal(fat.placed[1].x, 104);
});

test('shelfPack: a row wraps rather than running past the target width', () => {
  const boxes = Array.from({ length: 9 }, (_, i) => ({ key: i, w: 100, h: 100 }));
  const r = shelfPack(boxes, { aspect: 1, gap: 0 });
  const rows = new Set(r.placed.map((p) => p.y));
  assert.equal(rows.size, 3);
  assert.equal(r.width, 300);
});

test('shelfPack: a box wider than the target still gets its own row, not a squeeze', () => {
  const r = shelfPack([{ key: 'wide', w: 900, h: 20 }, { key: 'a', w: 20, h: 20 }, { key: 'b', w: 20, h: 20 }], { aspect: 1, gap: 5 });
  const wide = r.placed.find((p) => p.key === 'wide');
  assert.equal(wide.x, 0);
  assert.ok(r.width >= 900);
});

test('shelfPack: a dozen lumpy boxes still come out near the aspect asked for', () => {
  // The doc's reason for trying several widths: with lumpy boxes the plain
  // sqrt(area x aspect) guess misses badly. On these twelve that single guess
  // produces a 0.83-wide block for a 1.61-wide pane — taller than it is wide.
  const lumpy = [
    { key: 0, w: 420, h: 120 }, { key: 1, w: 80, h: 300 }, { key: 2, w: 210, h: 210 }, { key: 3, w: 60, h: 60 },
    { key: 4, w: 340, h: 90 }, { key: 5, w: 130, h: 260 }, { key: 6, w: 95, h: 95 }, { key: 7, w: 280, h: 150 },
    { key: 8, w: 70, h: 190 }, { key: 9, w: 160, h: 110 }, { key: 10, w: 240, h: 70 }, { key: 11, w: 50, h: 320 },
  ];
  const r = shelfPack(lumpy, { aspect: 1.61, gap: 24 });
  const got = r.width / r.height;
  assert.ok(got > 1.3 && got < 2.0, `block came out ${got.toFixed(3)} wide for a 1.61 pane (${r.width}x${r.height})`);
});

test('shelfPack: no candidate row is narrower than the widest box', () => {
  // One 600-wide box among eight 40s. Every candidate width starts at 600, so the
  // eight small boxes share ONE row under it. Without that floor the search picks
  // a target narrower than the wide box and shreds them into five rows.
  const boxes = [{ key: 'wide', w: 600, h: 30 }, ...Array.from({ length: 8 }, (_, i) => ({ key: i, w: 40, h: 40 }))];
  const r = shelfPack(boxes, { aspect: 1.6, gap: 10 });
  assert.ok(r.width >= 600, 'block is at least as wide as its widest box: ' + r.width);
  assert.equal(new Set(r.placed.map((p) => p.y)).size, 2, 'the wide box, then the eight small ones on one row');
  assert.equal(r.height, 80);
});

test('shelfPack: the gap between STACKED rows grows with the taller node radius too', () => {
  // Two 50x50 boxes, one row each. The vertical step is gap + the larger maxR of
  // the two rows — 24 + 30 — not the bare gap: a fat hub on the bottom edge of one
  // row would otherwise touch the row below it.
  const r = shelfPack([{ key: 'a', w: 50, h: 50, maxR: 30 }, { key: 'b', w: 50, h: 50, maxR: 30 }], { aspect: 0.1, gap: 24 });
  assert.deepEqual(r.placed.map((p) => p.y), [0, 104]);
});

test('shelfPack: a non-finite box size is a RangeError that names the field', () => {
  assert.throws(() => shelfPack([{ w: Infinity, h: 10 }, { w: 10, h: 10 }]), (e) =>
    e instanceof RangeError && /box 0 width/.test(e.message));
  assert.throws(() => shelfPack([{ w: 10, h: 10 }, { w: 10, h: NaN }]), (e) =>
    e instanceof RangeError && /box 1 height/.test(e.message));
  assert.throws(() => shelfPack([{ w: 10, h: 10, maxR: -Infinity }]), (e) =>
    e instanceof RangeError && /box 0 maxR/.test(e.message));
});

test('shelfPack: a non-finite aspect is a RangeError, not a null nobody can use', () => {
  assert.throws(() => shelfPack([{ w: 10, h: 10 }], { aspect: Infinity }), (e) =>
    e instanceof RangeError && /aspect/.test(e.message));
  assert.throws(() => shelfPack([{ w: 10, h: 10 }], { aspect: NaN }), RangeError);
});

test('shelfPack: a non-finite gap is a RangeError too — it reaches the area the same way', () => {
  assert.throws(() => shelfPack([{ w: 10, h: 10 }], { gap: Infinity }), (e) =>
    e instanceof RangeError && /gap/.test(e.message));
  assert.throws(() => shelfPack([{ w: 10, h: 10 }], { gap: NaN }), RangeError);
  assert.doesNotThrow(() => shelfPack([{ w: 10, h: 10 }], { gap: 0 }));
});

test('shelfPack: a MISSING size is still 0, not an error — only a present, unusable one throws', () => {
  const r = shelfPack([{ key: 'a', w: 10, h: 10 }, { key: 'b' }], { gap: 0 });
  assert.equal(r.placed.length, 2);
  assert.deepEqual(r.placed.find((p) => p.key === 'b'), { key: 'b', x: 10, y: 0, w: 0, h: 0 });
});

test('shelfPack: same input, same packing — twice', () => {
  const boxes = Array.from({ length: 25 }, (_, i) => ({ key: i, w: 40 + i, h: 90 - i, maxR: 3 }));
  assert.deepEqual(shelfPack(boxes, { aspect: 1.4 }), shelfPack(boxes, { aspect: 1.4 }));
});

test('shelfPack: keys default to the input index when none are given', () => {
  const r = shelfPack([{ w: 10, h: 10 }, { w: 90, h: 90 }], { gap: 0 });
  assert.deepEqual(r.placed.map((p) => p.key), [1, 0]);
});

// ---------------------------------------------------------------------------
// settleComponents — the ERD's whole layout, as a value in / value out
// ---------------------------------------------------------------------------

// A synthetic schema: `n` tables in families of ten (a hub with nine spokes),
// every third family chained to the next, so the picture has both a big lump and
// a crowd of small ones — the shape a real schema has.
function synthSchema(n) {
  const nodes = [], links = [];
  for (let i = 0; i < n; i++) nodes.push({ id: 't' + i, r: 5 + Math.sqrt((i % 13) + 1) * 4.2 });
  for (let f = 0; f < n / 10; f++) for (let i = 1; i < 10; i++) links.push({ from: 't' + (f * 10), to: 't' + (f * 10 + i) });
  for (let f = 0; f + 1 < n / 10; f += 3) links.push({ from: 't' + (f * 10), to: 't' + ((f + 1) * 10) });
  return { nodes, links };
}
const boxOf = (placed) => {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const p of placed) { x1 = Math.min(x1, p.x - p.r); y1 = Math.min(y1, p.y - p.r); x2 = Math.max(x2, p.x + p.r); y2 = Math.max(y2, p.y + p.r); }
  return { x1, y1, x2, y2, w: x2 - x1, h: y2 - y1 };
};
const overlapsIn = (placed) => {
  let count = 0, worst = 0;
  for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) {
    const a = placed[i], b = placed[j], d = Math.hypot(b.x - a.x, b.y - a.y);
    if (d < a.r + b.r - 1e-6) { count++; worst = Math.max(worst, a.r + b.r - d); }
  }
  return { count, worst };
};

test('seededRandom: the same seed is the same stream, and it stays in [0,1)', () => {
  const a = seededRandom(42), b = seededRandom(42);
  const xs = Array.from({ length: 200 }, () => a());
  assert.deepEqual(xs, Array.from({ length: 200 }, () => b()));
  for (const x of xs) assert.ok(x >= 0 && x < 1, 'out of range: ' + x);
  assert.notDeepEqual(xs, Array.from({ length: 200 }, seededRandom(43)));
});

test('settleComponents: the same pack lays out IDENTICALLY, twice', () => {
  // The old settle started every node at a Math.random() point, so the same
  // schema drew a different picture on every load. Nothing here may.
  const { nodes, links } = synthSchema(120);
  const a = settleComponents(nodes, links, { width: 1166, height: 856, seed: 7 });
  const b = settleComponents(nodes, links, { width: 1166, height: 856, seed: 7 });
  assert.deepEqual(a.nodes, b.nodes);
  assert.deepEqual(a.components, b.components);
});

test('settleComponents: any seed still lands every node, and none overlap', () => {
  // The seed is a GUARANTEE, not a knob: it exists so the picture cannot vary
  // between two loads of the same pack. It reaches only the community pass's
  // visiting order, and on every schema measured here label propagation
  // converges to the same labelling whatever order it visits in — so a
  // different seed is not asserted to be a different picture, only a valid one.
  const { nodes, links } = synthSchema(60);
  for (const seed of [1, 2, 99, 65535]) {
    const got = settleComponents(nodes, links, { width: 900, height: 620, seed });
    for (const n of got.nodes) assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y), `seed ${seed}: ${n.id}`);
    assert.equal(overlapsIn(got.nodes).count, 0, 'seed ' + seed);
  }
});

test('settleComponents: it does not mutate what it was handed', () => {
  const { nodes, links } = synthSchema(40);
  const before = JSON.parse(JSON.stringify({ nodes, links }));
  settleComponents(nodes, links, { width: 900, height: 620, seed: 5 });
  assert.deepEqual({ nodes, links }, before);
});

test('settleComponents: 400 tables, and no two circles overlap', () => {
  const { nodes, links } = synthSchema(400);
  const got = settleComponents(nodes, links, { width: 1166, height: 856, seed: 7 });
  assert.equal(got.nodes.length, 400);
  const ov = overlapsIn(got.nodes);
  assert.equal(ov.count, 0, `${ov.count} overlapping pairs, worst ${ov.worst.toFixed(2)}px`);
});

test('settleComponents: the packed block follows the PANE it is drawn in', () => {
  // Whatever shape the pane is, the components are packed into a block of about
  // that shape — a tall block in a wide pane fits on screen only at a scale
  // where a table is a dot.
  const { nodes, links } = synthSchema(400);
  for (const [w, h] of [[1600, 500], [1166, 856], [600, 1200], [900, 900]]) {
    const box = boxOf(settleComponents(nodes, links, { width: w, height: h, seed: 7 }).nodes);
    const ratio = (box.w / box.h) / (w / h);
    assert.ok(ratio > 1 / 1.5 && ratio < 1.5,
      `pane ${w}x${h} (aspect ${(w / h).toFixed(2)}) gave a block of aspect ${(box.w / box.h).toFixed(2)}`);
  }
});

test('settleComponents: a PINNED node comes out exactly where it went in', () => {
  const { nodes, links } = synthSchema(120);
  const pinned = nodes.map((n, i) => (i === 0 || i === 55 ? { ...n, pinned: true, x: -500 + i * 20, y: 240 - i } : n));
  const got = settleComponents(pinned, links, { width: 1166, height: 856, seed: 7 });
  const at = new Map(got.nodes.map((n) => [n.id, n]));
  assert.deepEqual([at.get('t0').x, at.get('t0').y], [-500, 240]);
  assert.deepEqual([at.get('t55').x, at.get('t55').y], [-500 + 55 * 20, 240 - 55]);
});

test('settleComponents: two pinned nodes inside the gap do not blow the picture up', () => {
  // No sweep can part two pinned nodes, so reporting that overlap as "the relax
  // failed" used to inflate everything else x1.5 seven times over (x17, off
  // screen) chasing something it could never fix.
  const { nodes, links } = synthSchema(60);
  const free = settleComponents(nodes, links, { width: 900, height: 620, seed: 3 });
  const stuck = nodes.map((n, i) => (i === 0 ? { ...n, pinned: true, x: 400, y: 300 }
    : i === 1 ? { ...n, pinned: true, x: 405, y: 300 } : n));
  const got = settleComponents(stuck, links, { width: 900, height: 620, seed: 3 });
  const a = boxOf(free.nodes), b = boxOf(got.nodes.filter((n) => n.id !== 't0' && n.id !== 't1'));
  assert.ok(b.w < a.w * 2 && b.h < a.h * 2,
    `free nodes span ${b.w.toFixed(0)}x${b.h.toFixed(0)} against ${a.w.toFixed(0)}x${a.h.toFixed(0)} with nothing pinned`);
});

test('settleComponents: a re-settle from its own output leaves pinned nodes alone', () => {
  const { nodes, links } = synthSchema(80);
  const first = settleComponents(nodes, links, { width: 1166, height: 856, seed: 7 });
  const again = settleComponents(first.nodes.map((n) => ({ ...n, pinned: n.id === 't10' })), links,
    { width: 1166, height: 856, seed: 7 });
  const at = new Map(again.nodes.map((n) => [n.id, n]));
  const was = first.nodes.find((n) => n.id === 't10');
  assert.deepEqual([at.get('t10').x, at.get('t10').y], [was.x, was.y]);
  assert.equal(overlapsIn(again.nodes).count, 0);
});

test('settleComponents: every node lands somewhere finite, including a lone one', () => {
  const got = settleComponents(
    [{ id: 'a', r: 8 }, { id: 'b', r: 8 }, { id: 'lonely', r: 6 }], [{ from: 'a', to: 'b' }],
    { width: 900, height: 620, seed: 1 });
  assert.equal(got.components.length, 2, 'the lone table is its own component');
  for (const n of got.nodes) assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y), n.id + ' has no place');
  assert.equal(overlapsIn(got.nodes).count, 0);
});

test('settleComponents: nothing in, nothing out', () => {
  assert.deepEqual(settleComponents([], []), { nodes: [], components: [] });
  assert.deepEqual(settleComponents(null, null).nodes, []);
});

test('settleComponents: a link naming a table that is not drawn is ignored', () => {
  const got = settleComponents([{ id: 'a', r: 8 }, { id: 'b', r: 8 }],
    [{ from: 'a', to: 'ghost' }, { from: 'a', to: 'b' }], { width: 900, height: 620, seed: 1 });
  assert.equal(got.components.length, 1);
  assert.equal(got.nodes.length, 2);
});

// ---------------------------------------------------------------------------
// The page does not carry a copy of this module any more: the server hands it
// the module itself, minus the `export ` keywords. This is the guard on that
// transform — and on there being nothing left to drift.
// ---------------------------------------------------------------------------

test('the page is served THIS module, minus its `export ` keywords', () => {
  const out = handleViewerLib('GET', '/viewer/lib/graphlayout.js', { viewerLibDir: path.join(ROOT, 'src', 'viewer') });
  assert.equal(out.status, 200);
  assert.equal(out.headers['content-type'], 'application/javascript; charset=utf-8');
  const mod = fs.readFileSync(path.join(ROOT, 'src/viewer/graphlayout.mjs'), 'utf8');
  assert.equal(out.body, mod.replace(/^export /gm, ''));
  // What comes out is a classic script: every function is declared, nothing is
  // exported, and the names land in the one scope the page's files share.
  assert.equal(/^export /m.test(out.body), false);
  for (const fn of ['hopsFrom', 'ringPlan', 'ringLayout', 'nameFamily', 'familyCounts', 'familyPalette', 'witnessWidth',
    'connectedComponents', 'shelfPack', 'seededRandom', 'settleComponents']) {
    assert.ok(out.body.includes(`function ${fn}(`), `the served text is missing ${fn}`);
  }
});

test('the page loads it, and no copy of it is left behind', () => {
  const html = fs.readFileSync(path.join(ROOT, 'viewer/index.html'), 'utf8');
  assert.ok(html.includes('<script src="/viewer/lib/graphlayout.js">'), 'the page does not load the module');
  const jsDir = path.join(ROOT, 'viewer', 'js');
  const page = fs.readdirSync(jsDir).sort().map((f) => fs.readFileSync(path.join(jsDir, f), 'utf8')).join('\n');
  for (const fn of ['function settleComponents(', 'function shelfPack(', 'function connectedComponents(']) {
    assert.equal(page.includes(fn), false, `${fn} is declared twice: in the module and in the page`);
    assert.equal(html.includes(fn), false, `${fn} is declared twice: in the module and in the page`);
  }
});
