// summary.mjs — the whole pack in a dozen boxes: groups of routes by where their code sits, and the tables they reach.
//
// WHAT THIS MODULE OWNS. The Graph tab draws every node, which is what a
// developer tracing one change wants and what nobody presenting a system to a
// review board can read: a common-components pack is over ten thousand nodes. So
// this answers a coarser question from the same walk every whole-pack census
// uses (`walkEndpoints`): which parts of the code reach which families of tables,
// in about ten boxes a side, with every box openable down to the routes and
// tables it holds.
//
// A GROUP IS A GUESS UNLESS THE PROJECT DECLARED ONE, and it is named for what
// it is. Three rules, in this order:
//
//   declared    `moduleAttribution.packageDepth` in the profile: the handler's
//               package cut to that many segments, the rule `map` and `coupling`
//               already follow. The project said where its modules are.
//   code path   otherwise: the handlers' packages, read from the top down past
//               every level where one branch holds four in five of them, and cut
//               where they split (`descendGroups`). `egovframework.com.sym.mnu.web`
//               is `sym`; jeecg's `org.jeecg.modules.system` is `system`, and the
//               few `com.*` handlers beside it are a box of their own. It is where
//               the code sits, which is often a business area and not always one.
//   path        a pack with no handler, or whose handlers all sit in one package:
//               the route's first path segment.
//
// Table families follow the same descent over the table names: by words where
// the names are mostly written with underscores (`t_ds_task` under a shared
// `t_ds`), by letters where they are not (eGovFrame's `COMTNxxx`, `COMTHxxx`).
// When one group still holds most of the routes the answer says so, because a
// summary with one box in it summarizes nothing, and names the profile key.
//
// WHAT IT MUST NEVER DO: change the graph, or draw a line the walk did not take.
// A link between a group and a family is one or more tables some route of the
// group reaches through a statement, graded by the weakest link on the way.

import { walkEndpoints, handlersOf } from './walks.mjs';

/** How many groups and table families are drawn before the rest are folded into one box. */
export const SUMMARY_LIMIT = 10;

/** The folded box's name, on both sides. */
export const OTHERS = '(others)';

/** A route whose handler cannot be read. */
const NO_HANDLER = '(no handler)';

/** Past this share of the routes in one group, the summary says it is one box. */
const LOPSIDED_SHARE = 0.8;

const RANK = Object.freeze({ UNRESOLVED: 0, RUNTIME_ONLY: 1, HEURISTIC: 2, SOUND_SET: 3, EXACT: 4 });
const weakest = (a, b) => (a == null ? b : b == null ? a : RANK[a] <= RANK[b] ? a : b);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The package segments of one handler symbol id, its class name dropped. */
function packageOf(handlerId) {
  const key = String(handlerId).replace(/^symbol:/, '');
  const owner = key.includes('#') ? key.slice(0, key.lastIndexOf('#')) : key;
  return owner.split('.').filter(Boolean).slice(0, -1);
}

/** The tokens every item of a list starts with. */
function commonTokens(items) {
  const first = items[0].tokens;
  let n = first.length;
  for (const it of items) {
    let i = 0;
    while (i < n && it.tokens[i] === first[i]) i += 1;
    n = i;
  }
  return first.slice(0, n);
}

/** The biggest entry of a Map of arrays, ties to the lower key. */
function largest(children) {
  let best = null;
  for (const [tok, items] of children) {
    if (!best || items.length > best[1].length || (items.length === best[1].length && tok < best[0])) best = [tok, items];
  }
  return best;
}

/**
 * GROUPS BY A SHARED PREFIX, WHEREVER THE MEANING STARTS. Items are token lists
 * (package segments, table-name words, or letters). While one branch holds most
 * of the items and splitting it would not make more than `wide` branches, the
 * walk goes one level down; every branch it leaves behind is a group of its own,
 * named by its whole path. Where it stops, each branch is a group.
 *
 * @param {{key:string, tokens:string[]}[]} items
 * @returns {{prefix:string[], groupOf:Map<string,string>}}
 */
export function descendGroups(items, { sep, wide, fullNames = false }) {
  const groupOf = new Map();
  const prefix = [];
  let pool = items;
  for (let level = 0; pool.length > 0; level += 1) {
    const children = new Map();
    for (const it of pool) {
      const tok = it.tokens[level];
      if (tok === undefined) { groupOf.set(it.key, prefix.join(sep) || '(root)'); continue; }
      if (!children.has(tok)) children.set(tok, []);
      children.get(tok).push(it);
    }
    if (children.size === 0) break;
    const [topTok, topItems] = largest(children);
    const below = new Set(topItems.map((it) => it.tokens[level + 1]).filter((x) => x !== undefined));
    // One branch only is no grouping at all, so it is gone down however wide it opens.
    const descend = topItems.length / pool.length >= LOPSIDED_SHARE && below.size > 0 && (below.size <= wide || children.size === 1);
    for (const [tok, its] of children) {
      if (descend && tok === topTok) continue;
      // A branch left behind, or a name of letters, is named by what its members share.
      const name = descend || fullNames ? commonTokens(its).join(sep) : tok;
      for (const it of its) groupOf.set(it.key, name);
    }
    if (!descend) break;
    prefix.push(topTok);
    pool = topItems;
  }
  return { prefix, groupOf };
}

/**
 * The rule the groups follow, and each route's group under it.
 * @returns {{rule:object, groupOf:Map<string,string>}}
 */
/** Routes grouped by their path segments, with the same descent (`/api/mdm/x` under a shared `/api` is `mdm`). */
function pathGroups(endpoints, limit, extra = {}) {
  const items = endpoints.map((ep) => ({ key: ep.id, tokens: String(ep.path ?? '').split('/').filter((s) => s && !s.startsWith('{') && !s.startsWith(':')) }));
  const d = descendGroups(items, { sep: '/', wide: limit * 2 });
  return { rule: { kind: 'path', ...extra, commonPath: `/${d.prefix.join('/')}` }, groupOf: d.groupOf };
}

export function groupRule(graph, endpoints, packageDepth, limit = SUMMARY_LIMIT) {
  if (packageDepth != null) {
    return { rule: { kind: 'declared', packageDepth }, groupOf: new Map(endpoints.map((ep) => [ep.id, ep.group])) };
  }
  const items = [];
  const groupOf = new Map();
  for (const ep of endpoints) {
    const h = handlersOf(graph, ep.id)[0];
    if (h) items.push({ key: ep.id, tokens: packageOf(h) });
    else groupOf.set(ep.id, NO_HANDLER);
  }
  if (items.length === 0) return pathGroups(endpoints, limit);
  const d = descendGroups(items, { sep: '.', wide: limit * 2 });
  // Every route's code in one package is one box: the route paths then say more.
  if (new Set(d.groupOf.values()).size < 2) return pathGroups(endpoints, limit, { onePackage: d.prefix.join('.') });
  for (const [k, v] of d.groupOf) groupOf.set(k, v);
  return { rule: { kind: 'code-path', commonPrefix: d.prefix.join('.') }, groupOf };
}

/** A table's bare name, lower case, schema dropped. */
const bareTable = (tableId) => {
  const name = String(tableId).replace(/^table:/, '');
  return (name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name).toLowerCase();
};

/**
 * The family of every reached table. Names that are mostly written in words
 * (`pms_product`, `t_ds_task`) split at the underscore; names that are not
 * (`comtnbbs`) split by letters, and a family is then named in full.
 */
export function familyRule(tableIds, limit = SUMMARY_LIMIT) {
  const names = tableIds.map((id) => [id, bareTable(id)]);
  const words = names.filter(([, n]) => n.indexOf('_') > 0).length >= names.length / 2;
  const items = names.map(([id, n]) => ({ key: id, tokens: words ? n.split('_').filter(Boolean) : [...n] }));
  const d = descendGroups(items, { sep: words ? '_' : '', wide: limit * 2, fullNames: !words });
  return { rule: words ? { kind: 'name-words', separator: '_', commonPrefix: d.prefix.join('_') } : { kind: 'name-letters', commonPrefix: d.prefix.join('') }, familyOf: d.groupOf };
}

/** Every table one route reaches, with the weakest grade on the way to each. */
function tablesOfEndpoint(graph, ep, stmtTables) {
  const out = new Map();
  for (const s of ep.statements) {
    let tables = stmtTables.get(s.id);
    if (!tables) {
      tables = graph.outEdges(s.id).filter((e) => e.type === 'EXECUTES').map((e) => ({ id: e.to, grade: e.grade }));
      stmtTables.set(s.id, tables);
    }
    for (const t of tables) out.set(t.id, weakest(out.get(t.id), weakest(s.grade, t.grade)));
  }
  return out;
}

/** Rows ranked by size then name, the first `limit` kept and the rest folded into one. */
function foldRanked(rows, size, limit) {
  const ranked = [...rows].sort((a, b) => size(b) - size(a) || cmp(a.name, b.name));
  return { kept: ranked.slice(0, limit), folded: ranked.slice(limit) };
}

/**
 * THE SUMMARY of one pack.
 *
 * @param {import('./graph.mjs').Graph} graph
 * @param {{mode?:string, depth?:number, packageDepth?:number|null, limit?:number}} [opts]
 */
export function buildSummary(graph, opts = {}) {
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : SUMMARY_LIMIT;
  const { endpoints, walk } = walkEndpoints(graph, { mode: opts.mode, depth: opts.depth, packageDepth: opts.packageDepth ?? null });
  const { rule, groupOf } = groupRule(graph, endpoints, opts.packageDepth ?? null, limit);
  const stmtTables = new Map();
  const reach = endpoints.map((ep) => [ep, tablesOfEndpoint(graph, ep, stmtTables)]);
  const allTables = [...new Set(reach.flatMap(([, t]) => [...t.keys()]))].sort(cmp);
  const fam = familyRule(allTables, limit);
  const groups = new Map();
  const families = new Map();
  const pairs = new Map();
  for (const [ep, tables] of reach) {
    const g = groupOf.get(ep.id);
    if (!groups.has(g)) groups.set(g, { name: g, endpoints: [], tables: new Set() });
    groups.get(g).endpoints.push(ep.id);
    for (const [tableId, grade] of tables) {
      groups.get(g).tables.add(tableId);
      const f = fam.familyOf.get(tableId);
      if (!families.has(f)) families.set(f, { name: f, tables: new Set() });
      families.get(f).tables.add(tableId);
      const key = `${g}\n${f}`;
      if (!pairs.has(key)) pairs.set(key, { group: g, family: f, tables: new Set(), endpoints: new Set(), grade: null });
      const pair = pairs.get(key);
      pair.tables.add(tableId);
      pair.endpoints.add(ep.id);
      pair.grade = weakest(pair.grade, grade);
    }
  }
  return summaryAnswer({ groups, families, pairs, rule: { groups: rule, tables: fam.rule }, limit, endpoints, walk });
}

/** The kept boxes, the folded ones as one box a side, and the links between them. */
function summaryAnswer({ groups, families, pairs, rule, limit, endpoints, walk }) {
  const g = foldRanked([...groups.values()], (x) => x.endpoints.length, limit);
  const f = foldRanked([...families.values()], (x) => x.tables.size, limit);
  const keptGroups = new Set(g.kept.map((x) => x.name));
  const keptFamilies = new Set(f.kept.map((x) => x.name));
  const links = new Map();
  for (const p of pairs.values()) {
    const group = keptGroups.has(p.group) ? p.group : OTHERS;
    const family = keptFamilies.has(p.family) ? p.family : OTHERS;
    const key = `${group}\n${family}`;
    if (!links.has(key)) links.set(key, { group, family, tables: new Set(), endpoints: new Set(), grade: null });
    const l = links.get(key);
    for (const t of p.tables) l.tables.add(t);
    for (const e of p.endpoints) l.endpoints.add(e);
    l.grade = weakest(l.grade, p.grade);
  }
  const groupRow = (x) => ({ name: x.name, endpoints: [...x.endpoints].sort(cmp), tables: x.tables.size });
  const familyRow = (x) => ({ name: x.name, tables: [...x.tables].sort(cmp) });
  const foldedGroups = g.folded.map(groupRow);
  const foldedFamilies = f.folded.map(familyRow);
  const biggest = g.kept[0];
  return {
    rule,
    groups: g.kept.map(groupRow),
    otherGroups: { groups: foldedGroups.length, names: foldedGroups.map((x) => x.name), endpoints: foldedGroups.flatMap((x) => x.endpoints).sort(cmp) },
    families: f.kept.map(familyRow),
    otherFamilies: { families: foldedFamilies.length, names: foldedFamilies.map((x) => x.name), tables: foldedFamilies.flatMap((x) => x.tables).sort(cmp) },
    links: [...links.values()]
      .map((l) => ({ group: l.group, family: l.family, tables: l.tables.size, endpoints: l.endpoints.size, grade: l.grade }))
      .sort((a, b) => cmp(a.group, b.group) || cmp(a.family, b.family)),
    totals: { endpoints: endpoints.length, groups: groups.size, families: families.size, tablesReached: [...families.values()].reduce((n, x) => n + x.tables.size, 0) },
    lopsided: biggest && endpoints.length > 0 && biggest.endpoints.length / endpoints.length > LOPSIDED_SHARE
      ? { group: biggest.name, share: Math.round((biggest.endpoints.length / endpoints.length) * 100) } : null,
    walk,
  };
}
