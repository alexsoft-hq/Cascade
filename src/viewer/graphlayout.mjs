// graphlayout.mjs — pure maths and naming for the viewer's two graph pictures:
// the Graph tab's concentric hop rings and the ERD's name-family colouring.
// No DOM, no state, no I/O — every function is a value in, a value out.
//
// THE PAGE RUNS THIS FILE. The viewer is one global scope, not modules, so it
// cannot `import` from src/: `cascade view` hands it THIS text at
// `GET /viewer/lib/graphlayout.js`, minus the `export ` keywords, and the names
// below land in the scope viewer/js/*.js share. There is no copy — there used
// to be one in the page, with a test whose whole job was to notice when
// somebody edited one of the two — so this logic is under test here and drawn
// with there, from one file.

/**
 * BFS hop distance from `focus`, walking edges the way the ANSWER walked them.
 * `direction` is the neighborhood tool's own: 'down' follows the arrow
 * (from → to), 'up' walks against it (to → from), 'both' (the default) ignores
 * direction entirely. This matters because the tool returns every edge BETWEEN
 * the nodes it collected, not only the ones it walked: in an `up` answer a
 * downward edge is a shortcut that would put a node three steps up on ring 1.
 *
 * A node the edges never reach gets no entry — the caller decides what to do
 * with it (the Graph tab parks those on one outer ring, labelled `unreached`,
 * rather than pretending they are at hop 0 or at some hop it did not measure).
 * @param {string} focus
 * @param {{from:string,to:string}[]} edges
 * @param {'up'|'down'|'both'} [direction='both']
 * @returns {Map<string,number>} node id -> hop
 */
export function hopsFrom(focus, edges, direction = 'both') {
  const adj = new Map();
  const add = (a, b) => { let s = adj.get(a); if (!s) adj.set(a, s = new Set()); s.add(b); };
  const down = direction !== 'up', up = direction !== 'down';
  for (const e of edges || []) { if (down) add(e.from, e.to); if (up) add(e.to, e.from); }
  const hop = new Map([[focus, 0]]);
  let frontier = [focus];
  for (let h = 1; frontier.length; h++) {
    const next = [];
    for (const id of frontier) for (const nb of adj.get(id) || []) {
      if (hop.has(nb)) continue;
      hop.set(nb, h);
      next.push(nb);
    }
    frontier = next;
  }
  return hop;
}

/**
 * Where each hop ring sits. Ring h is at least `step` further out than ring
 * h-1, at least h*step from the centre, and — this is the part that keeps the
 * picture readable — far enough out that its own nodes fit AROUND it: a ring
 * holding 90 nodes needs a circumference of 90 node-widths, whatever its hop.
 *
 * Then one evening pass. A crowded outer ring can leave the inner ones packed
 * into a dot at the middle with a wide empty moat around them (hop 1 with 23
 * nodes at r=130, hop 2 with 102 at r=536); spreading the rings across the
 * radius the picture ALREADY takes costs nothing and gives the inner rings the
 * room. It can only push a ring outward, so the fit and the ordering hold.
 * @param {Map<number,number>} counts  hop -> how many nodes sit on it
 * @param {{step?:number, gap?:number, nodeR?:number}} opts
 * @returns {{hop:number,count:number,radius:number}[]} ordered by hop
 */
export function ringPlan(counts, opts = {}) {
  const step = opts.step ?? 120;
  const gap = opts.gap ?? 14;
  const nodeR = opts.nodeR ?? 7;
  const hops = [...counts.keys()].sort((a, b) => a - b);
  const out = [];
  let prev = null;
  for (const h of hops) {
    const count = counts.get(h) || 0;
    if (h === 0) { out.push({ hop: 0, count, radius: 0 }); prev = 0; continue; }
    const need = count > 1 ? (count * (nodeR * 2 + gap)) / (2 * Math.PI) : 0;
    const floor = prev == null ? h * step : prev + step;
    const radius = Math.max(floor, h * step, need);
    out.push({ hop: h, count, radius });
    prev = radius;
  }
  const outer = out.length ? out[out.length - 1] : null;
  if (outer && outer.hop > 0) {
    for (const r of out) if (r.hop > 0) r.radius = Math.max(r.radius, (r.hop / outer.hop) * outer.radius);
  }
  return out;
}

/**
 * Lay `ids` out on their hop rings: even angular spacing within a ring, each
 * ring rotated by the golden angle so the spokes of neighbouring rings do not
 * line up into radial corridors. Deterministic — same input, same picture.
 * @param {string[]} ids  in the order they should appear around each ring
 * @param {(id:string)=>number} hopOf
 * @param {{cx?:number, cy?:number, step?:number, gap?:number, nodeR?:number}} opts
 * @returns {{plan:{hop:number,count:number,radius:number}[],
 *            nodes:{id:string,hop:number,angle:number,radius:number,x:number,y:number}[]}}
 */
export function ringLayout(ids, hopOf, opts = {}) {
  const cx = opts.cx ?? 0, cy = opts.cy ?? 0;
  const counts = new Map();
  for (const id of ids) { const h = hopOf(id); counts.set(h, (counts.get(h) || 0) + 1); }
  const plan = ringPlan(counts, opts);
  const radiusOf = new Map(plan.map((p) => [p.hop, p.radius]));
  const GOLDEN = Math.PI * (3 - Math.sqrt(5));
  const seen = new Map();
  const nodes = ids.map((id) => {
    const hop = hopOf(id);
    const i = seen.get(hop) || 0;
    seen.set(hop, i + 1);
    const n = counts.get(hop) || 1;
    const radius = radiusOf.get(hop) || 0;
    const angle = radius === 0 ? 0 : GOLDEN * hop + (i * 2 * Math.PI) / n;
    return { id, hop, angle, radius, x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) };
  });
  return { plan, nodes };
}

/**
 * What a ring is CALLED. Every ring but one is a measured hop. The exception is
 * the ring the caller parks nodes on that its BFS never reached: that ring is
 * not a distance the picture measured, so it says `unreached` instead of
 * claiming a hop one further out than the last real one.
 * @param {number} hop
 * @param {number|null} count  how many nodes sit on it (omitted from the label when null)
 * @param {number|null} [unreachedHop]  the parking ring's hop, if the caller made one
 * @returns {string}
 */
export function hopRingLabel(hop, count, unreachedHop = null) {
  const head = (unreachedHop != null && hop === unreachedHop) ? 'unreached' : 'hop ' + hop;
  return count == null ? head : head + '  (' + count + ')';
}

/**
 * The leading token of a snake_case name — "pms_product" -> "pms". null when
 * the name carries no underscore: there is nothing to group by, and a caller
 * that gets null everywhere should say so rather than invent families.
 * @param {string} name
 * @returns {string|null}
 */
export function nameFamily(name) {
  const s = String(name ?? '');
  const i = s.indexOf('_');
  return i > 0 ? s.slice(0, i) : null;
}

/**
 * The families present in `names`, biggest first (ties alphabetically). Names
 * with no family are counted together under `family:null` and always come last.
 * @param {string[]} names
 * @returns {{family:string|null,count:number}[]}
 */
export function familyCounts(names) {
  const m = new Map();
  for (const n of names || []) { const f = nameFamily(n); m.set(f, (m.get(f) || 0) + 1); }
  const rows = [...m.entries()].map(([family, count]) => ({ family, count }));
  rows.sort((a, b) => {
    if ((a.family === null) !== (b.family === null)) return a.family === null ? 1 : -1;
    if (a.count !== b.count) return b.count - a.count;
    return String(a.family) < String(b.family) ? -1 : String(a.family) > String(b.family) ? 1 : 0;
  });
  return rows;
}

/**
 * Assign each family a colour from a palette the page ALREADY has — this is
 * presentation derived from names, so it borrows existing tokens rather than
 * inventing a new scale. Biggest family takes the first colour; if there are
 * more families than colours the palette repeats (and the legend, which lists
 * the names, is what disambiguates).
 * @param {(string|null)[]} families  in priority order
 * @param {string[]} palette
 * @returns {Map<string|null,string>}
 */
export function familyPalette(families, palette) {
  const out = new Map();
  if (!palette || !palette.length) return out;
  let i = 0;
  for (const f of families || []) { out.set(f, palette[i % palette.length]); i++; }
  return out;
}

/**
 * How thick an edge witnessed by `count` statements is drawn: `min` at one
 * witness, `max` at `top`, linear between. One witness and ten witnesses are
 * not the same claim, and the picture should not say they are.
 * @param {number} count
 * @param {number} top  the most witnesses any edge in this picture has
 * @returns {number}
 */
export function witnessWidth(count, top, min = 1, max = 3) {
  const n = Number(count) || 0;
  if (!(top > 1)) return min;
  const t = Math.max(0, Math.min(1, (n - 1) / (top - 1)));
  return min + (max - min) * t;
}

/**
 * The connected components of an undirected graph, over the edges the picture
 * actually DRAWS. A node no drawn edge touches is its own one-member component
 * — that is a fact about the drawing, not a claim that the table is unrelated.
 *
 * Deterministic: components come out in the order their first member appears in
 * `ids`, and each component's members keep that same order. Ids repeated in the
 * input are visited once; an edge naming an unknown id is ignored.
 * @param {string[]} ids
 * @param {{from:string,to:string}[]} edges
 * @returns {string[][]}
 */
export function connectedComponents(ids, edges) {
  const rank = new Map();
  const list = [];
  for (const id of ids || []) if (!rank.has(id)) { rank.set(id, rank.size); list.push(id); }
  const adj = new Map(list.map((id) => [id, []]));
  for (const e of edges || []) {
    if (!adj.has(e.from) || !adj.has(e.to) || e.from === e.to) continue;
    adj.get(e.from).push(e.to);
    adj.get(e.to).push(e.from);
  }
  const seen = new Set();
  const out = [];
  for (const id of list) {
    if (seen.has(id)) continue;
    seen.add(id);
    const comp = [id];
    for (let i = 0; i < comp.length; i++) {
      for (const nb of adj.get(comp[i])) if (!seen.has(nb)) { seen.add(nb); comp.push(nb); }
    }
    comp.sort((a, b) => rank.get(a) - rank.get(b));
    out.push(comp);
  }
  return out;
}

/**
 * Shelf packing: lay boxes out in rows, biggest area first, wrapping when a row
 * passes a target width. sqrt(total area x aspect) is the first guess at that
 * width; a handful of scalings of it are tried and the one whose finished block
 * comes closest to `aspect` wins, because with a dozen lumpy boxes the first
 * guess can miss badly (a 1.27-wide block in a 1.61-wide pane wastes a third of
 * the room). No candidate is ever narrower than the widest box.
 *
 * WHY THIS EXISTS. A force settle that repels every node from every other one
 * pushes disconnected clusters hundreds of pixels apart, and the picture then
 * fits on screen only at a scale where the tables are dots. Settling each
 * cluster on its own and then packing the results puts the clusters shoulder to
 * shoulder, so the fit is set by how big the clusters really are.
 *
 * The gap between neighbours is `gap` plus the larger of the two boxes' node
 * radii: a box's bounding box is measured to its node CENTRES' extremes plus
 * radius already, and the extra keeps a fat hub on one edge from touching its
 * neighbour. Deterministic given the input order (ties in area break by index).
 *
 * A missing (undefined/null) box size or radius means 0. A NON-FINITE one — or a
 * non-finite `aspect` or `gap` — is a bug in the caller, not a layout: every
 * candidate then scores Infinity, no candidate can beat the first, and what came
 * back used to be `null` for the caller to dereference. It throws a RangeError
 * naming the field instead.
 * @param {{key?:any,w:number,h:number,maxR?:number}[]} boxes
 * @param {{aspect?:number, gap?:number}} opts
 * @throws {RangeError} on a non-finite box w/h/maxR, aspect or gap
 * @returns {{placed:{key:any,x:number,y:number,w:number,h:number}[], width:number, height:number}}
 */
export function shelfPack(boxes, opts = {}) {
  const finite = (v, what) => {
    if (v === undefined || v === null) return 0;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new RangeError(`shelfPack: ${what} must be a finite number, got ${v}`);
    return n > 0 ? n : 0;
  };
  if (opts.aspect !== undefined && opts.aspect !== null && !Number.isFinite(Number(opts.aspect)))
    throw new RangeError(`shelfPack: aspect must be a finite number, got ${opts.aspect}`);
  if (opts.gap !== undefined && opts.gap !== null && !Number.isFinite(Number(opts.gap)))
    throw new RangeError(`shelfPack: gap must be a finite number, got ${opts.gap}`);
  const aspect = opts.aspect > 0 ? opts.aspect : 1;
  const gap = opts.gap ?? 24;
  const items = (boxes || []).map((b, i) => ({
    i,
    key: b.key === undefined ? i : b.key,
    w: finite(b.w, `box ${i} width`),
    h: finite(b.h, `box ${i} height`),
    maxR: finite(b.maxR, `box ${i} maxR`),
  }));
  if (!items.length) return { placed: [], width: 0, height: 0 };
  let area = 0, widest = 0;
  for (const it of items) { area += (it.w + gap) * (it.h + gap); widest = Math.max(widest, it.w); }
  const order = items.slice().sort((a, b) => (b.w * b.h) - (a.w * a.h) || a.i - b.i);
  const rowsFor = (target) => {
    const rows = [];
    let row = [], rowW = 0;
    for (const it of order) {
      const step = row.length ? gap + Math.max(row[row.length - 1].maxR, it.maxR) : 0;
      if (row.length && rowW + step + it.w > target) { rows.push(row); row = []; rowW = 0; }
      const s = row.length ? gap + Math.max(row[row.length - 1].maxR, it.maxR) : 0;
      it.rx = rowW + s;
      rowW = it.rx + it.w;
      row.push(it);
    }
    if (row.length) rows.push(row);
    const placed = [];
    let y = 0, width = 0, prevMaxR = 0;
    for (let ri = 0; ri < rows.length; ri++) {
      let rowH = 0, rowMaxR = 0, rowW2 = 0;
      for (const it of rows[ri]) { rowH = Math.max(rowH, it.h); rowMaxR = Math.max(rowMaxR, it.maxR); rowW2 = Math.max(rowW2, it.rx + it.w); }
      if (ri > 0) y += gap + Math.max(prevMaxR, rowMaxR);
      for (const it of rows[ri]) placed.push({ key: it.key, x: it.rx, y, w: it.w, h: it.h });
      y += rowH;
      prevMaxR = rowMaxR;
      width = Math.max(width, rowW2);
    }
    return { placed, width, height: y };
  };
  const guess = Math.sqrt(area * aspect);
  let best = null, bestScore = Infinity;
  for (let f = 5; f <= 20; f++) {
    const got = rowsFor(Math.max(widest, guess * (f / 10)));
    const got2 = got.height > 0 ? got.width / got.height : aspect;
    const score = Math.abs(Math.log(got2 / aspect));
    if (score < bestScore - 1e-9) { bestScore = score; best = got; }
  }
  return best;
}

/**
 * A seeded stream of pseudo-random numbers in [0,1) — a 32-bit linear
 * congruential generator with Numerical Recipes' constants.
 *
 * WHY NOT Math.random. The ERD layout used it, so the same pack drew a
 * different picture on every load: a reader who learned where the order tables
 * sit had to find them again after a refresh, and no two screenshots of the
 * same schema could be compared. The randomness is only ever used to break
 * symmetry (which way two coincident nodes part, in what order the community
 * pass visits nodes), and a fixed stream breaks symmetry just as well while
 * making the layout a FUNCTION of the pack.
 * @param {number} seed
 * @returns {() => number}
 */
export function seededRandom(seed) {
  let s = (Number(seed) >>> 0) || 1;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

/**
 * The ERD's layout: settle each connected component on its own, then pack the
 * settled clusters shoulder to shoulder, then separate whatever still overlaps.
 * Nodes in, positions out — no DOM, no animation, no `Math.random`.
 *
 * WHY PER COMPONENT. Repulsion that reaches across a component pushes two
 * clusters sharing no edge hundreds of pixels apart, and the picture then fits
 * on screen only at a scale where a table is a dot. Nothing repels across a
 * component here; `shelfPack` decides where the finished clusters go, so the
 * fit is set by how big the clusters really are.
 *
 * WHAT EACH PHASE DOES.
 *  - seed:    every component's members on a sunflower spiral inside a disc,
 *             the discs packed, so the settle starts spread out instead of with
 *             every cluster piled on the same middle.
 *  - communities: label propagation, so the settle can push clusters WITHIN a
 *             component apart and hold each one together.
 *  - settle:  `iterations` steps of 1/d repulsion (boosted between communities),
 *             springs whose rest length grows with the node radii, a light pull
 *             to each community's centroid, a capped velocity and two collision
 *             sweeps a step.
 *  - pack:    each settled component measured and placed by `shelfPack` into a
 *             block the shape of the pane. A component holding a PINNED node is
 *             anchored on it: it keeps its place and leaves its slot empty,
 *             because the only translation that leaves a pinned node where the
 *             caller put it is none at all.
 *  - relax:   collision sweeps until no two circles overlap. If a round cannot
 *             clear a compressed hub-spoke pile, every free node is inflated
 *             outward from the centroid (a pure zoom — structure preserved) and
 *             the round runs again.
 *
 * A node given `pinned:true` comes out at exactly the `x`/`y` it went in with:
 * no phase moves it, and two pinned nodes inside the gap are a picture the
 * caller built, which no sweep may take apart.
 * @param {{id:string, r?:number, x?:number, y?:number, pinned?:boolean}[]} nodes
 * @param {{from:string,to:string}[]} links
 * @param {{width?:number, height?:number, gap?:number, seed?:number, iterations?:number,
 *          pack?:boolean, relaxAttempts?:number, relaxSweeps?:number}} opts
 * @returns {{nodes:{id:string,x:number,y:number,r:number,comp:number,comm:number}[],
 *            components:string[][]}}
 */
export function settleComponents(nodes, links, opts = {}) {
  const L = layoutState(nodes, links, opts);
  if (!L.list.length) return layoutResult(L);
  seedComponents(L);
  labelCommunities(L);
  L.cell = collisionCell(L);
  for (let i = 0; i < L.steps; i++) settleStep(L);
  if (opts.pack !== false) packComponents(L);
  relaxOverlaps(L);
  return layoutResult(L);
}

/**
 * Everything the phases below share, read once: the pane, the settings, the
 * nodes as mutable points, which component each one is in, the edges between
 * them, and the neighbour lists the community pass walks. One object, passed
 * along, so every phase is a function a reader can read on its own.
 */
function layoutState(nodes, links, opts) {
  const W = opts.width > 0 ? opts.width : 900;
  const H = opts.height > 0 ? opts.height : 620;
  const GAP = opts.gap ?? 16;
  const idx = new Map();
  const list = [];
  for (const n of nodes || []) {
    if (!n || idx.has(n.id)) continue;
    const m = {
      id: n.id, r: Number(n.r) || 0, pinned: !!n.pinned,
      x: Number.isFinite(n.x) ? Number(n.x) : 0, y: Number.isFinite(n.y) ? Number(n.y) : 0,
      vx: 0, vy: 0, comp: 0, comm: 0,
    };
    idx.set(m.id, m); list.push(m);
  }
  const components = connectedComponents(list.map((n) => n.id), links);
  components.forEach((c, ci) => { for (const id of c) idx.get(id).comp = ci; });
  const compNodes = components.map((c) => c.map((id) => idx.get(id)));
  const edges = [];
  for (const l of links || []) {
    const s = idx.get(l.from), t = idx.get(l.to);
    if (s && t && s !== t) edges.push({ s, t });
  }
  const adj = new Map(list.map((n) => [n.id, []]));
  for (const e of edges) { adj.get(e.s.id).push(e.t.id); adj.get(e.t.id).push(e.s.id); }
  return {
    W, H, GAP, idx, list, components, compNodes, edges, adj,
    steps: opts.iterations ?? 194,   // alpha 1 → 0.02 at the old 0.98 decay
    attempts: opts.relaxAttempts ?? 7,
    sweeps: opts.relaxSweeps ?? 250,
    rnd: seededRandom(opts.seed ?? 1),
    nComm: 1,
    cell: 1,
    center: compNodes.map((cn) => Math.min(0.02, 0.0006 + 6 / (cn.length * cn.length))),
  };
}

/** The answer: a position per node, and the components they were settled in. */
function layoutResult(L) {
  return {
    nodes: L.list.map((n) => ({ id: n.id, x: n.x, y: n.y, r: n.r, comp: n.comp, comm: n.comm })),
    components: L.components,
  };
}

/**
 * Where a component starts: its members on a sunflower spiral inside a disc,
 * the discs packed, so the settle begins spread out instead of with every
 * cluster piled on the same middle.
 */
function seedComponents(L) {
  const boxes = L.compNodes.map((cn, ci) => {
    const R = Math.max(24, Math.sqrt(cn.length) * 36);
    let mr = 0; for (const n of cn) if (n.r > mr) mr = n.r;
    return { key: ci, w: 2 * R, h: 2 * R, maxR: mr };
  });
  for (const slot of shelfPack(boxes, { aspect: L.W / L.H, gap: L.GAP + 8 }).placed) {
    const cn = L.compNodes[slot.key], R = slot.w / 2, ox = slot.x + R, oy = slot.y + R;
    cn.forEach((n, i) => {
      if (n.pinned) return;
      const ang = 2.399963229728653 * i, rr = R * Math.sqrt((i + 0.5) / cn.length);
      n.x = ox + rr * Math.cos(ang); n.y = oy + rr * Math.sin(ang); n.vx = 0; n.vy = 0;
    });
  }
}

/**
 * Communities, by label propagation: a cheap, dependency-free clustering INSIDE
 * a component, so the settle can give each cluster its own room and still hold
 * it together. The visiting order is shuffled by the seeded stream, never by
 * Math.random.
 */
function labelCommunities(L) {
  const lab = new Map(L.list.map((n) => [n.id, n.id]));
  const order = L.list.map((n) => n.id);
  for (let it = 0; it < 12; it++) {
    for (let i = order.length - 1; i > 0; i--) {
      const j = (L.rnd() * (i + 1)) | 0;
      const t = order[i]; order[i] = order[j]; order[j] = t;
    }
    let moved = false;
    for (const id of order) {
      const cnt = new Map();
      for (const nb of L.adj.get(id)) { if (nb === id) continue; const l = lab.get(nb); cnt.set(l, (cnt.get(l) || 0) + 1); }
      if (!cnt.size) continue;
      let best = lab.get(id), bc = -1;
      for (const [l, c] of cnt) { if (c > bc || (c === bc && l < best)) { best = l; bc = c; } }
      if (lab.get(id) !== best) { lab.set(id, best); moved = true; }
    }
    if (!moved) break;
  }
  const uniq = [...new Set(L.list.map((n) => lab.get(n.id)))];
  const ci = new Map(uniq.map((c, i) => [c, i]));
  for (const n of L.list) n.comm = ci.get(lab.get(n.id));
  L.nComm = uniq.length;
}

/**
 * The collision grid's cell: the largest separation two nodes can ask for. Each
 * node then only ever looks at the 9 cells around it, so a sweep is O(n) rather
 * than O(n²) and a 400-table schema settles in the time a 25-table one used to.
 */
function collisionCell(L) {
  let mr = 0; for (const n of L.list) if (n.r > mr) mr = n.r;
  return Math.max(1, 2 * mr + L.GAP + 1);
}

/** Part two overlapping nodes, and say by how much they overlapped. */
function pushApart(a, b, i, j, gap) {
  let dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy);
  // Two nodes at the very same point have no direction to part along, so one
  // is derived from the pair's own indices: the same picture every run.
  if (d < 0.01) { dx = ((i % 5) - 2) || 1; dy = ((j % 5) - 2) || 1; d = Math.hypot(dx, dy) || 1; }
  const min = a.r + b.r + gap;
  if (d >= min) return 0;
  const ov = min - d;
  const fa = a.pinned, fb = b.pinned;
  // Two PINNED nodes closer than the gap is a picture the caller built, and no
  // sweep may take it apart: neither may move, so the overlap survives every
  // pass and must not be reported as "the relax failed" — that is what used to
  // inflate the whole picture x17 chasing something it could never fix.
  if (fa && fb) return 0;
  const p = ov / d, wa = fa ? 0 : (fb ? 1 : 0.5), wb = fb ? 0 : (fa ? 1 : 0.5);
  a.x -= dx * p * wa; a.y -= dy * p * wa;
  b.x += dx * p * wb; b.y += dy * p * wb;
  return ov;
}

/**
 * One Gauss-Seidel collision sweep: corrections applied in place, so chains
 * resolve over a few sweeps. Returns the worst overlap depth it saw.
 */
function collideSweep(L) {
  const grid = new Map();
  for (let i = 0; i < L.list.length; i++) {
    const n = L.list[i], k = Math.floor(n.x / L.cell) + ':' + Math.floor(n.y / L.cell);
    const b = grid.get(k); if (b) b.push(i); else grid.set(k, [i]);
  }
  let worst = 0;
  for (let i = 0; i < L.list.length; i++) {
    const a = L.list[i], gx = Math.floor(a.x / L.cell), gy = Math.floor(a.y / L.cell);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const bucket = grid.get((gx + dx) + ':' + (gy + dy));
      if (!bucket) continue;
      for (const j of bucket) { if (j <= i) continue; const ov = pushApart(a, L.list[j], i, j, L.GAP); if (ov > worst) worst = ov; }
    }
  }
  return worst;
}

/**
 * The worst overlap there really is. The grid above is built from the positions
 * a sweep STARTED at, so a node that moves far during one can be missed; this is
 * the exact answer — every pair, no corrections — and it is what the relax loop
 * believes.
 */
function worstOverlap(L) {
  let worst = 0;
  for (let i = 0; i < L.list.length; i++) for (let j = i + 1; j < L.list.length; j++) {
    const a = L.list[i], b = L.list[j];
    if (a.pinned && b.pinned) continue;
    const ov = a.r + b.r + L.GAP - Math.hypot(b.x - a.x, b.y - a.y);
    if (ov > worst) worst = ov;
  }
  return worst;
}

/** One settle step: repulsion, springs, cohesion, then integrate and collide. */
function settleStep(L) {
  stepRepulsion(L);
  stepSprings(L);
  stepCohesion(L);
  stepIntegrate(L);
  collideSweep(L); collideSweep(L);
}

/**
 * Pairwise repulsion, O(n²) WITHIN a component. 1/d falloff (long-range, à la
 * Fruchterman-Reingold) so nodes spread into open space instead of piling in the
 * middle; boosted between communities, softened inside one.
 */
function stepRepulsion(L) {
  for (const cn of L.compNodes)
    for (let i = 0; i < cn.length; i++) for (let j = i + 1; j < cn.length; j++) {
      const a = cn[i], b = cn[j];
      const dx = a.x - b.x, dy = a.y - b.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1, dd = d < 24 ? 24 : d;
      const rep = (a.comm === b.comm ? 230 : 470) * (1 + (a.r + b.r) / 26) / dd;
      const fx = dx / d * rep, fy = dy / d * rep;
      a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
    }
}

/** Springs — rest length grows with node size, so big hubs don't crush neighbours. */
function stepSprings(L) {
  for (const e of L.edges) {
    const dx = e.t.x - e.s.x, dy = e.t.y - e.s.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
    const k = (d - (72 + e.s.r + e.t.r)) * 0.04, fx = dx / d * k, fy = dy / d * k;
    e.s.vx += fx; e.s.vy += fy; e.t.vx -= fx; e.t.vy -= fy;
  }
}

/** Community cohesion — a light pull toward each node's cluster centroid. */
function stepCohesion(L) {
  if (L.nComm <= 1) return;
  const sx = new Float64Array(L.nComm), sy = new Float64Array(L.nComm), sn = new Float64Array(L.nComm);
  for (const n of L.list) { sx[n.comm] += n.x; sy[n.comm] += n.y; sn[n.comm]++; }
  for (let c = 0; c < L.nComm; c++) if (sn[c]) { sx[c] /= sn[c]; sy[c] /= sn[c]; }
  for (const n of L.list) { if (n.pinned) continue; n.vx += (sx[n.comm] - n.x) * 0.005; n.vy += (sy[n.comm] - n.y) * 0.005; }
}

/**
 * Integrate + weak centering, each node toward ITS OWN component's centroid.
 * Velocity is capped per step (a Fruchterman-Reingold "temperature") so a node
 * overlapping many others cannot accumulate a huge push and fling itself off.
 */
function stepIntegrate(L) {
  const kx = new Float64Array(L.compNodes.length), ky = new Float64Array(L.compNodes.length);
  for (let c = 0; c < L.compNodes.length; c++) {
    const cn = L.compNodes[c];
    let mx = 0, my = 0;
    for (const n of cn) { mx += n.x; my += n.y; }
    kx[c] = mx / cn.length; ky[c] = my / cn.length;
  }
  for (const n of L.list) {
    if (n.pinned) { n.vx = 0; n.vy = 0; continue; }
    const c = L.center[n.comp];
    n.vx += (kx[n.comp] - n.x) * c; n.vy += (ky[n.comp] - n.y) * c;
    n.vx *= 0.9; n.vy *= 0.9;
    const sp = Math.hypot(n.vx, n.vy);
    if (sp > 26) { const s = 26 / sp; n.vx *= s; n.vy *= s; }
    n.x += n.vx; n.y += n.vy;
  }
}

/**
 * Each settled component measured and placed by `shelfPack` into a block the
 * shape of the pane. A component holding a PINNED node is anchored on it: it
 * keeps its place and leaves its slot empty, because the only translation that
 * leaves a pinned node where the caller put it is none at all.
 */
function packComponents(L) {
  if (L.components.length < 2) return;
  const boxes = L.compNodes.map((cn, ci) => {
    let a1 = Infinity, b1 = Infinity, a2 = -Infinity, b2 = -Infinity, mr = 0;
    for (const n of cn) {
      if (n.x - n.r < a1) a1 = n.x - n.r; if (n.y - n.r < b1) b1 = n.y - n.r;
      if (n.x + n.r > a2) a2 = n.x + n.r; if (n.y + n.r > b2) b2 = n.y + n.r;
      if (n.r > mr) mr = n.r;
    }
    return { key: ci, w: a2 - a1, h: b2 - b1, maxR: mr, x0: a1, y0: b1 };
  });
  for (const slot of shelfPack(boxes, { aspect: L.W / L.H, gap: 24 }).placed) {
    const cn = L.compNodes[slot.key];
    if (cn.some((n) => n.pinned)) continue;
    const b = boxes[slot.key], dx = slot.x - b.x0, dy = slot.y - b.y0;
    for (const n of cn) { n.x += dx; n.y += dy; n.vx = 0; n.vy = 0; }
  }
}

/**
 * Collision sweeps until no two circles overlap. If a round cannot clear a
 * compressed hub-spoke pile, every free node is inflated outward from the
 * centroid (a pure zoom — structure preserved) and the round runs again.
 */
function relaxOverlaps(L) {
  for (let attempt = 0; attempt < L.attempts; attempt++) {
    for (let p = 0; p < L.sweeps; p++) if (collideSweep(L) < 0.5) break;
    if (worstOverlap(L) < 0.5) break;
    let mx = 0, my = 0, k = 0;
    for (const n of L.list) if (!n.pinned) { mx += n.x; my += n.y; k++; }
    if (!k) break;
    mx /= k; my /= k;
    for (const n of L.list) if (!n.pinned) { n.x = mx + (n.x - mx) * 1.5; n.y = my + (n.y - my) * 1.5; }
  }
}
