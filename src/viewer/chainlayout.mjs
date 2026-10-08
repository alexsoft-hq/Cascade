// chainlayout.mjs — how one Flow or Impact chain is NAMED, ORDERED, SIZED and
// FOLDED, for the live lanes and the saved SVG alike. No DOM, no state, no I/O.
//
// WHY ONE FILE FOR BOTH PICTURES (RM67). The lanes used to cut every name to
// what a 180px column held ("PmsProd...", "GET /...", "user.ser..."), so the
// drawing named nothing, and the SVG a reader saved named things a third way.
// A reader who moves between the two must meet one name per node and one order
// per column. So both ask here, and nothing about a name or an order is decided
// in either renderer.
//
// THE PAGE RUNS THIS FILE, the way it runs graphlayout.mjs: `cascade view` hands
// it at `GET /viewer/lib/chainlayout.js` minus the `export ` keywords. So it
// imports nothing, and every name below lands in the page's one global scope.

/**
 * THE DASH IS THE GRADE, in one table for every picture Cascade draws: the
 * page's chips, legends and lines, and the saved SVGs. EXACT solid, SOUND_SET
 * dashed, HEURISTIC dash-dot, RUNTIME_ONLY and UNRESOLVED dotted. The chain and
 * its SVG drew HEURISTIC dotted while the legend drew it dash-dot, so the same
 * guess read as two different grades; there is now one spelling.
 */
export const GRADE_DASH = Object.freeze({ EXACT: null, SOUND_SET: '6 3', HEURISTIC: '6 3 1.5 3', RUNTIME_ONLY: '1.5 3', UNRESOLVED: '1.5 3' });

/**
 * The measures a lane is laid out with. The name font is a monospace at 12px,
 * so a name's width is its length times one advance; `chrome` is what a row
 * spends beside its name (padding and the kind glyph). A lane is as wide as its
 * longest name needs, between `min` and `max`, and a name longer than that
 * wraps onto `lines` lines. Past `foldOver` rows a lane folds (foldLane).
 */
export const CHAIN_FIT = Object.freeze({ min: 200, max: 360, charPx: 7.2, chrome: 41, lines: 2, foldOver: 14, foldKeep: 10, gap: 46, routeMax: 48 });

// A web or TypeScript file, named by its path: its functions are named by the
// file, where a Java method is named by its class.
const CHAIN_FILE_ID = /\/|\.(?:m?[jt]sx?|vue|svelte|html?|ftl)$/i;

/** One dotted Java-style name: a class (or mapper) and its member, the package as qualifiers. */
function dottedParts(segs, member) {
  const cls = member == null ? segs.slice(-2, -1)[0] ?? '' : segs[segs.length - 1];
  const core = member == null ? segs.slice(-2).join('.') : `${cls}.${member}`;
  const pkg = segs.slice(0, member == null ? -2 : -1).reverse();
  return { core, owner: cls || core, levels: pkg.length, at: (q) => (q ? `${pkg.slice(0, q).reverse().join('.')}.${core}` : core) };
}

/** A member of a FILE: `Class.method` when the file declares a class, else `file.function`. */
function fileParts(file, member) {
  const parts = file.split('/').filter((s) => s !== '' && s !== '.' && s !== '..');
  const name = parts.pop() ?? file;
  const stem = name.replace(/\.[^.]+$/, '');
  // An ORM call site is the method's n-th call: `UserService.deleteUser #0`.
  const ord = /\/(\d+)$/.exec(member);
  const bare = ord ? member.slice(0, ord.index) : member;
  const tail = ord ? ` #${ord[1]}` : '';
  const hasClass = bare.includes('.');
  const dirs = parts.reverse();   // nearest folder first
  // `index.vue` names nothing: the directory it sits in is what a reader calls it.
  const owner = hasClass ? bare.slice(0, bare.lastIndexOf('.')) : (stem === 'index' && dirs.length ? dirs[0] : stem);
  const core = hasClass ? bare + tail : (/^\(/.test(bare) ? `${owner} ${bare}` : `${owner}.${bare}`) + tail;
  // Lengthened, it is the file itself (`rows.vue#load` beside `rows.js#load`),
  // then the file under its folders, nearest first.
  const at = (q) => (q ? `${[...dirs.slice(0, q - 1).reverse(), name].join('/')}#${bare}${tail}` : core);
  return { core, owner: ord && hasClass ? bare : owner, levels: dirs.length + 1, at };
}

/** A route or a screen path, cut from the middle past `max` characters, the tail kept whole. */
function pathParts(head, path, max) {
  const segs = String(path).split('/');
  const full = head + path;
  const owner = segs.find((s) => s !== '') ?? '/';
  if (full.length <= max || segs.length <= 3) return { core: full, owner, levels: 0, at: () => full };
  // Keep the first segment, then as many last segments as fit, and never fewer
  // than the last two that are NAMES: `{token}/{thirdType}` tells two routes
  // apart far less than the `getLoginUser` in front of them.
  let keep = 0;
  for (let named = 0; keep < segs.length - 2 && named < 2;) { keep += 1; if (!/^[{:]/.test(segs[segs.length - keep])) named += 1; }
  keep = Math.max(2, keep);
  while (keep < segs.length - 2 && `${head}/${segs[1]}/…/${segs.slice(-(keep + 1)).join('/')}`.length <= max) keep += 1;
  const at = (q) => {
    const k = Math.min(segs.length - 2, keep + q);
    return k >= segs.length - 2 ? full : `${head}/${segs[1]}/…/${segs.slice(-k).join('/')}`;
  };
  return { core: at(0), owner, levels: Math.max(0, segs.length - 2 - keep), at };
}

/**
 * THE NAME OF ONE NODE, and how to lengthen it. `at(0)` is the short form a
 * lane shows; `at(q)` adds q more of what tells it apart (package segments, the
 * file and its folders, more of a route), up to `levels`. `owner` is the group a
 * folded lane puts it in: its class, its mapper, its file, its route's first
 * segment, its table.
 * @param {string} id  a node id, `kind:key`
 * @param {{routeMax?:number}} [fit]
 * @returns {{core:string, owner:string, levels:number, at:(q:number)=>string}}
 */
export function labelParts(id, fit = CHAIN_FIT, call = null) {
  const s = String(id);
  const c = s.indexOf(':');
  const kind = c >= 0 ? s.slice(0, c) : '';
  const key = c >= 0 ? s.slice(c + 1) : s;
  const max = fit.routeMax ?? CHAIN_FIT.routeMax;
  if (kind === 'endpoint') {
    const sp = key.indexOf(' ');
    return sp > 0 && key[sp + 1] === '/' ? pathParts(key.slice(0, sp + 1), key.slice(sp + 1), max) : { core: key, owner: key, levels: 0, at: () => key };
  }
  if (kind === 'screen') return key.startsWith('/') ? pathParts('', key, max) : { core: key, owner: key, levels: 0, at: () => key };
  if (kind === 'table') return { core: key, owner: key, levels: 0, at: () => key };
  if (kind === 'column') return dottedParts(key.split('.'), null);
  // An ORM statement is keyed by its kind of client first (`prisma:`, `typeorm:`).
  // The short name leaves it off; it is the first thing that tells two call
  // sites of one method apart when two clients count their calls from #0 each.
  const client = kind === 'statement' ? /^([a-z][a-z0-9-]*):(?!\/)/.exec(key) : null;
  if (client) return withCall(withClient(memberParts(key.slice(client[0].length)), client[1]), call);
  return memberParts(key);
}

/**
 * AN ORM CALL SITE NAMED BY WHAT IT DOES (RM67-U2e): `UserService.deleteUser →
 * Access.deleteMany`, where it was `UserService.deleteUser #0` beside #1 to #4,
 * numbers that tell a reader nothing. Two sites of one method that make the same
 * call grow by their ordinal first, then by their client and their file.
 */
function withCall(p, call) {
  if (!call) return p;
  const bare = p.core.replace(/ #\d+$/, '');
  return { ...p, core: `${bare} → ${call}`, levels: p.levels + 1, at: (q) => (q ? `${p.at(q - 1)} → ${call}` : `${bare} → ${call}`) };
}

/**
 * The ORM calls an answer's statements make, by node id, as a name reads them
 * (`Access.deleteMany`, or the bare operation where the call names no model).
 * @param {object} a  a flow answer
 * @returns {Map<string,string>}
 */
export function ormCallsOf(a) {
  const out = new Map();
  const say = (c) => (c.model ? `${c.model}.${c.operation}` : c.operation);
  for (const x of (a && a.statements) || []) if (x && x.call) out.set(`statement:${x.id}`, say(x.call));
  const e = a && a.entry;
  if (e && e.kind === 'statement' && e.call) out.set(e.start || `statement:${e.id}`, say(e.call));
  return out;
}

/** A method, a statement or a dotted name, as labelParts reads it once its kind is known. */
function memberParts(key) {
  const h = key.indexOf('#');
  if (h >= 0) {
    const left = key.slice(0, h);
    return CHAIN_FILE_ID.test(left) ? fileParts(left, key.slice(h + 1)) : dottedParts(left.split('.'), key.slice(h + 1));
  }
  const segs = key.split('.');
  return segs.length > 1 ? dottedParts(segs, null) : { core: key, owner: key, levels: 0, at: () => key };
}

/**
 * An ORM statement's name with its client as the FIRST step it grows by:
 * `UserService.deleteUser #0 (prisma)` beside `... #0 (typeorm)`, then the
 * file and its folders as for any member.
 */
function withClient(p, client) {
  return { ...p, levels: p.levels + 1, at: (q) => (q ? `${p.at(q - 1)} (${client})` : p.at(0)) };
}

/**
 * EVERY NAME IN ONE VIEW, each as short as it can be while no two read the
 * same. Two nodes that would get one short name both get more of what tells
 * them apart, one step at a time, until they differ or run out of steps.
 * @param {string[]} ids
 * @param {object} [fit]
 * @param {Map<string,string>} [calls]  what an ORM call site does, by id (ormCallsOf)
 * @returns {Map<string,{text:string, owner:string}>}
 */
export function chainLabels(ids, fit = CHAIN_FIT, calls = null) {
  const uniq = [...new Set(ids)];
  const parts = new Map(uniq.map((id) => [id, labelParts(id, fit, calls ? calls.get(id) : null)]));
  const q = new Map(uniq.map((id) => [id, 0]));
  const text = (id) => parts.get(id).at(q.get(id));
  for (let round = 0; round < 12; round += 1) {
    const same = new Map();
    for (const id of uniq) {
      const k = text(id);
      if (!same.has(k)) same.set(k, []);
      same.get(k).push(id);
    }
    let grew = false;
    for (const group of same.values()) {
      if (group.length < 2) continue;
      for (const id of group) if (q.get(id) < parts.get(id).levels) { q.set(id, q.get(id) + 1); grew = true; }
    }
    if (!grew) break;
  }
  return new Map(uniq.map((id) => [id, { text: text(id), owner: parts.get(id).owner }]));
}

// Where a name may break: after a dot, a slash, a hash, an underscore or a
// space first, and only where there is none of those, before a capital that
// follows a lower-case letter. `Impl.` then `calcAmount`, not `Impl.calc` then
// `Amount`.
function nameBreakAt(s, width) {
  const from = Math.min(width, s.length - 1);
  for (let i = from; i > width / 2; i -= 1) if ('./#_ -'.includes(s[i - 1])) return i;
  for (let i = from; i > width / 2; i -= 1) if (/[A-Z]/.test(s[i]) && /[a-z0-9]/.test(s[i - 1])) return i;
  return width;
}

/**
 * One name as at most `lines` lines of `perLine` characters. A name too long
 * even for that loses its MIDDLE, never its tail: the tail is the method, the
 * statement or the route's last segment, which is what tells two rows apart.
 * @param {string} text
 * @param {number} perLine
 * @param {number} [lines]
 * @returns {string[]}
 */
export function fitLines(text, perLine, lines = CHAIN_FIT.lines) {
  const src = String(text ?? '');
  const room = Math.max(4, perLine);
  // A line that breaks early at a name boundary leaves the last line longer
  // than the room. That surplus comes out of the MIDDLE too, one more cut, and
  // the lines are laid again: cutting the end of the last line dropped the
  // tail, so `...DescV1` and `...DescV2` drew the same (review 3b, N4).
  for (let budget = room * lines - 2; budget >= room;) {
    const out = [];
    let s = src.length > budget ? middleCut(src, budget) : src;
    while (s.length > room && out.length < lines - 1) {
      const at = nameBreakAt(s, room);
      out.push(s.slice(0, at));
      s = s.slice(at);
    }
    if (s.length <= room) return [...out, s];
    budget -= s.length - room;
  }
  return [middleCut(src, room)];
}

/** A name cut to `budget` characters in the middle, at a name boundary, the tail kept whole. */
function middleCut(s, budget) {
  if (s.length <= budget) return s;
  const head = s.slice(0, nameBreakAt(s, Math.floor(budget * 0.35)));
  return `${head}…${s.slice(s.length - (budget - head.length - 1))}`;
}

/**
 * How wide one lane is: what its longest name needs on one line, between the
 * floor and the cap, and how many characters a line then holds.
 * @param {string[]} texts
 * @param {object} [fit]
 * @returns {{width:number, perLine:number}}
 */
export function laneWidth(texts, fit = CHAIN_FIT) {
  const longest = texts.reduce((m, x) => Math.max(m, String(x ?? '').length), 0);
  const width = Math.min(fit.max, Math.max(fit.min, Math.ceil(fit.chrome + longest * fit.charPx)));
  return { width, perLine: Math.max(8, Math.floor((width - fit.chrome) / fit.charPx)) };
}

/** Every key's neighbours, both ways, over the links given. */
function chainNeighbours(links) {
  const nb = new Map();
  const add = (a, b) => { if (!nb.has(a)) nb.set(a, []); nb.get(a).push(b); };
  for (const l of links) if (l.from != null && l.to != null && l.from !== l.to) { add(l.from, l.to); add(l.to, l.from); }
  return nb;
}

/** Sort one lane in place by `score`, but only INSIDE each run of one `group`. */
function sortWithinGroups(rows, score) {
  let i = 0;
  while (i < rows.length) {
    let j = i + 1;
    while (j < rows.length && rows[j].group === rows[i].group) j += 1;
    const run = rows.slice(i, j).map((r, k) => ({ r, k, s: score(r) }));
    run.sort((a, b) => (a.s - b.s) || (a.k - b.k));
    run.forEach((x, k) => { rows[i + k] = x.r; });
    i = j;
  }
}

/**
 * ORDER EACH LANE TO CUT CROSSINGS, the barycenter way: a few sweeps left to
 * right and back, each row moved toward the average place of the rows it links
 * to in the lanes already placed and in its own lane (a call inside one column
 * counts too). A row only moves INSIDE its group, one hop and one grade: the
 * candidate band a lane separates from the proven rows is never mixed to save
 * a crossing. Deterministic: ties keep the order the engine gave.
 * @param {{key:string, group:string}[][]} lanes  each lane in the engine's order
 * @param {{from:string, to:string}[]} links
 * @param {number} [sweeps]
 * @returns {{key:string, group:string}[][]} new arrays, the rows reordered
 */
export function orderLanes(lanes, links, sweeps = 4) {
  const cur = lanes.map((rows) => rows.slice());
  const nb = chainNeighbours(links);
  const pos = new Map();
  const laneOf = new Map();
  const place = () => cur.forEach((rows, li) => rows.forEach((r, i) => { pos.set(r.key, (i + 0.5) / rows.length); laneOf.set(r.key, li); }));
  place();
  const sweep = (li, side) => {
    const score = (r) => {
      const ns = (nb.get(r.key) ?? []).filter((k) => laneOf.has(k) && (laneOf.get(k) === li || Math.sign(laneOf.get(k) - li) === side));
      return ns.length ? ns.reduce((s, k) => s + pos.get(k), 0) / ns.length : pos.get(r.key);
    };
    sortWithinGroups(cur[li], score);
    place();
  };
  for (let s = 0; s < sweeps; s += 1) {
    for (let li = 1; li < cur.length; li += 1) sweep(li, -1);
    for (let li = cur.length - 2; li >= 0; li -= 1) sweep(li, 1);
  }
  return cur;
}

/**
 * AN EMPTY LANE GOES LAST (RM67-U2b). A lane the walk found nothing in is drawn
 * after every lane that has rows, each group keeping its own order, so no line
 * crosses an empty lane on its way to a lane further out. Up from a route the
 * service and endpoint lanes are usually empty (only a client in this pack
 * calls a route over HTTP), and drawn in walk order every line from the route
 * to the frontend ran through both. The first lane, the entry, stays first.
 * @template T
 * @param {T[]} lanes  the entry lane, then the answer's lanes in walk order
 * @param {(lane:T)=>number} rowsOf  how many rows a lane has on this picture
 * @returns {T[]}
 */
export function emptyLanesLast(lanes, rowsOf) {
  const [entry, ...rest] = lanes;
  return [entry, ...rest.filter((l) => rowsOf(l) > 0), ...rest.filter((l) => !(rowsOf(l) > 0))];
}

/**
 * How many pairs of links cross between neighbouring lanes, for the tests and
 * the report: the number the ordering above is meant to bring down.
 * @param {{key:string}[][]} lanes
 * @param {{from:string, to:string}[]} links
 * @returns {number}
 */
export function countCrossings(lanes, links) {
  const at = new Map();
  lanes.forEach((rows, li) => rows.forEach((r, i) => at.set(r.key, [li, i])));
  let n = 0;
  for (let li = 0; li + 1 < lanes.length; li += 1) {
    const segs = [];
    for (const l of links) {
      const a = at.get(l.from), b = at.get(l.to);
      if (!a || !b) continue;
      if (a[0] === li && b[0] === li + 1) segs.push([a[1], b[1]]);
      else if (b[0] === li && a[0] === li + 1) segs.push([b[1], a[1]]);
    }
    for (let i = 0; i < segs.length; i += 1) {
      for (let j = i + 1; j < segs.length; j += 1) if ((segs[i][0] - segs[j][0]) * (segs[i][1] - segs[j][1]) < 0) n += 1;
    }
  }
  return n;
}

/**
 * THE CHAIN THROUGH ONE NODE: what led to it and what it leads to, not
 * everything connected to it. Growing both ways at once would leak sideways,
 * from a table up to its statement and back down to every other table.
 * @param {{from:string, to:string}[]} links
 * @param {string} key
 * @returns {Set<string>}
 */
export function chainThrough(links, key) {
  const keep = new Set([key]);
  for (const down of [true, false]) {
    const seen = new Set([key]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const l of links) {
        const a = down ? l.from : l.to, b = down ? l.to : l.from;
        if (seen.has(a) && !seen.has(b)) { seen.add(b); keep.add(b); grew = true; }
      }
    }
  }
  return keep;
}

/** What a folded lane draws, and which drawn item stands in for every row. */
function foldResult(items) {
  const proxy = new Map();
  let shown = 0;
  for (const it of items) {
    for (const r of it.rows) proxy.set(r.key, it.type === 'row' ? r.key : it.key);
    if (it.type === 'row') shown += 1;
  }
  return { items, proxy, shown };
}

/**
 * A LONG LANE, FOLDED, so 88 services do not bury the eight a reader came for.
 *
 * Past `over` rows, the rows of one owner (one class, one mapper, one file, one
 * route prefix) inside one hop and one grade become one group row a reader
 * opens in place; and if that is still long, the first `show` items stay and
 * the rest fold into one "more" row. A row in `keep` (the selected chain, what
 * a search found) is never folded, and nothing is dropped: every hidden row has
 * a PROXY, the drawn item its lines are drawn to.
 * @param {{key:string, group:string, owner:string}[]} rows  one lane, in order
 * @param {{keep?:Set<string>, open?:Set<string>, lane?:string, over?:number, show?:number}} [opts]
 * @returns {{items:{type:string, key:string, group:string, owner?:string, rows:object[]}[], proxy:Map<string,string>, shown:number}}
 */
export function foldLane(rows, opts = {}) {
  const over = opts.over ?? CHAIN_FIT.foldOver;
  const show = opts.show ?? CHAIN_FIT.foldKeep;
  const keep = opts.keep ?? new Set();
  const open = opts.open ?? new Set();
  const lane = opts.lane ?? '';
  const one = (r) => ({ type: 'row', key: r.key, group: r.group, rows: [r] });
  if (rows.length <= over) return foldResult(rows.map(one));
  const items = [];
  for (let i = 0, j; i < rows.length; i = j) {
    for (j = i + 1; j < rows.length && rows[j].group === rows[i].group;) j += 1;
    const run = rows.slice(i, j);
    const mates = new Map();
    for (const r of run) if (!keep.has(r.key)) mates.set(r.owner, [...(mates.get(r.owner) ?? []), r]);
    const placed = new Set();
    for (const r of run) {
      const gk = `${lane}|${r.group}|${r.owner}`;
      const m = mates.get(r.owner) ?? [];
      if (keep.has(r.key) || m.length < 2 || open.has(gk)) { items.push(one(r)); continue; }
      if (placed.has(gk)) continue;
      placed.add(gk);
      items.push({ type: 'group', key: gk, group: r.group, owner: r.owner, rows: m });
    }
  }
  const moreKey = `${lane}|more`;
  if (items.length <= over || open.has(moreKey)) return foldResult(items);
  const vis = [];
  const hid = [];
  items.forEach((it, k) => ((k < show || it.rows.some((r) => keep.has(r.key))) ? vis : hid).push(it));
  if (hid.length) vis.push({ type: 'more', key: moreKey, group: '', rows: hid.flatMap((it) => it.rows) });
  return foldResult(vis);
}
