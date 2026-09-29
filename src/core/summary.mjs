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
// Table families follow the same descent over the words of the table names
// (`t_ds_task` under a shared `t_ds` is `task`; `SymbolProfile` is `symbol`):
// a word ends at an underscore, a hyphen or a change of case, however the
// project writes its names. Where most names are one word and most of them
// start with the same letters, the letters are read instead (eGovFrame's
// `COMTNxxx`, `COMTHxxx`). A table a rule pack names as one a framework made
// to join two others (Prisma's `_OrderToTag`, kind `table.join-table`) is not
// read by its name at all: it goes with the tables the graph joins it to, when
// they sit in one family, and into `(join tables)` when they do not.
// When one group still holds most of the routes the answer says so, because a
// summary with one box in it summarizes nothing, and names the profile key.
//
// WHAT IT MUST NEVER DO: change the graph, or draw a line the walk did not take.
// A link between a group and a family is one or more tables some route of the
// group reaches through a statement, graded by the weakest link on the way.

import { sqlEdgesOf } from './graph.mjs';
import { walkEndpoints, handlersOf, laneGroupOf } from './walks.mjs';
import { builtinRegistry } from './rules/registry.mjs';

/** How many groups and table families are drawn before the rest are folded into one box. */
export const SUMMARY_LIMIT = 10;

/** The folded box's name, on both sides. */
export const OTHERS = '(others)';

/** The family of the join tables whose tables are not in one family on the map. */
export const JOIN_TABLES = '(join tables)';

/** A route whose handler cannot be read. */
const NO_HANDLER = '(no handler)';

/** Past this share of the routes in one group, the summary says it is one box. */
const LOPSIDED_SHARE = 0.8;

const RANK = Object.freeze({ UNRESOLVED: 0, RUNTIME_ONLY: 1, HEURISTIC: 2, SOUND_SET: 3, EXACT: 4 });
const weakest = (a, b) => (a == null ? b : b == null ? a : RANK[a] <= RANK[b] ? a : b);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Where one handler's code sits, as segments: a Java owner's package, its class
 * name dropped, or a file-keyed owner's directories, its file name dropped. A
 * lane that keys a symbol by its file (`app/users/users.controller.ts#Users.get`)
 * has a directory where Java has a package, and reading that path by its dots
 * made a group of every file.
 */
function packageOf(handlerId) {
  const key = String(handlerId).replace(/^symbol:/, '');
  const owner = key.includes('#') ? key.slice(0, key.lastIndexOf('#')) : key;
  if (owner.includes('/')) return { tokens: owner.split('/').filter(Boolean).slice(0, -1), sep: '/' };
  return { tokens: owner.split('.').filter(Boolean).slice(0, -1), sep: '.' };
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
/**
 * Routes grouped by their path segments, with the same descent (`/api/mdm/x`
 * under a shared `/api` is `mdm`). Where every route's lane wrote the group its
 * deployment prefix leaves (`apiGroup`), that is the group, and nothing is guessed.
 */
function pathGroups(graph, endpoints, limit, extra = {}) {
  const lane = endpoints.map((ep) => laneGroupOf(graph.nodes.get(ep.id)));
  if (endpoints.length > 0 && lane.every((g) => g !== null)) {
    return { rule: { kind: 'lane', ...extra }, groupOf: new Map(endpoints.map((ep, i) => [ep.id, lane[i]])) };
  }
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
  let sep = '.';
  for (const ep of endpoints) {
    const h = handlersOf(graph, ep.id)[0];
    if (!h) { groupOf.set(ep.id, NO_HANDLER); continue; }
    const where = packageOf(h);
    items.push({ key: ep.id, tokens: where.tokens });
    sep = where.sep;
  }
  if (items.length === 0) return pathGroups(graph, endpoints, limit);
  const d = descendGroups(items, { sep, wide: limit * 2 });
  // Every route's code in one package is one box: the route paths then say more.
  if (new Set(d.groupOf.values()).size < 2) return pathGroups(graph, endpoints, limit, { onePackage: d.prefix.join(sep) });
  for (const [k, v] of d.groupOf) groupOf.set(k, v);
  return { rule: { kind: 'code-path', commonPrefix: d.prefix.join(sep), ...(sep === '/' ? { by: 'directory' } : {}) }, groupOf };
}

/** A table's bare name as it is written, schema dropped. */
const bareTable = (tableId) => {
  const name = String(tableId).replace(/^table:/, '');
  return name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
};

/**
 * The words of a name, lower case. A word ends at an underscore or a hyphen, and
 * where the case changes: before a capital that follows a small letter
 * (`symbolProfile`), and before the last capital of a run that a small letter
 * follows (`HTTPRequest` is http, request). A digit stays with its word
 * (`demo01`). A separator at either end makes no word, so `_OrderToTag` is
 * order, to, tag and never a family "_".
 */
export function nameWords(name) {
  return String(name ?? '').split(/[_-]+/)
    .flatMap((part) => part.split(/(?<=[a-z])(?=[A-Z])|(?<=[A-Z0-9])(?=[A-Z][a-z])/))
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/**
 * The families of tables read by their names. Most names one word each, and
 * most of them starting with the same letters (`COMTNBBS`, `COMTNUSER`,
 * `COMTHLOG`): the letters after that start tell them apart, and a family is
 * named in full. Otherwise the words do (`pms_product`, `SymbolProfile`).
 */
function familiesByName(tableIds, limit) {
  const named = tableIds.map((id) => ({ key: id, words: nameWords(bareTable(id)) }));
  const wide = limit * 2;
  if (named.filter((n) => n.words.length <= 1).length > named.length / 2) {
    const d = descendGroups(named.map((n) => ({ key: n.key, tokens: [...n.words.join('')] })), { sep: '', wide, fullNames: true });
    if (d.prefix.length > 0) return { rule: { kind: 'name-letters', commonPrefix: d.prefix.join('') }, familyOf: d.groupOf };
  }
  const d = descendGroups(named.map((n) => ({ key: n.key, tokens: n.words })), { sep: '_', wide });
  return { rule: { kind: 'name-words', separator: '_', commonPrefix: d.prefix.join('_') }, familyOf: d.groupOf };
}

/**
 * Where each join table goes: with the tables it joins when every one of them
 * is on the map in one family, else into JOIN_TABLES. Read against the families
 * of the tables placed by name only, so the order of the join tables decides nothing.
 */
function placeJoinTables(joinTables, familyOf) {
  const placed = [...joinTables].map(([id, j]) => {
    const families = new Set(j.joins.map((t) => familyOf.get(t) ?? null));
    const [only] = families;
    return [id, families.size === 1 && only !== null ? only : JOIN_TABLES];
  });
  for (const [id, family] of placed) familyOf.set(id, family);
}

/**
 * THE FAMILY RULE: the family of every reached table. The join tables a rule
 * names (`joinTables`, each with that rule and the tables the graph joins it
 * to) are placed by what they join; every other table by its name.
 *
 * @param {string[]} tableIds
 * @param {{limit?:number, joinTables?:Map<string,{rule:string, joins:string[]}>}} [opts]
 */
export function familyRule(tableIds, { limit = SUMMARY_LIMIT, joinTables = new Map() } = {}) {
  const fam = familiesByName(tableIds.filter((id) => !joinTables.has(id)), limit);
  placeJoinTables(joinTables, fam.familyOf);
  if (joinTables.size > 0) {
    fam.rule.joinTables = { rules: [...new Set([...joinTables.values()].map((j) => j.rule))].sort(cmp), tables: joinTables.size };
  }
  return fam;
}

/** A table's column names, as the catalog that declared it writes them. */
const columnsOf = (graph, tableId) => graph.outEdges(tableId).filter((e) => e.type === 'DECLARES')
  .map((e) => graph.nodes.get(e.to)?.name ?? e.to.slice(e.to.lastIndexOf('.') + 1));

/** The other tables the graph joins one table to, either way round. */
const joinedTables = (graph, tableId) => [...new Set([
  ...graph.outEdges(tableId).filter((e) => e.type === 'JOINS').map((e) => e.to),
  ...graph.inEdges(tableId).filter((e) => e.type === 'JOINS').map((e) => e.from),
])].filter((t) => t !== tableId).sort(cmp);

/**
 * The reached tables a `table.join-table` rule names, each with the first rule
 * that names it and the tables the graph joins it to.
 */
function joinTablesOf(graph, tableIds, rules) {
  const out = new Map();
  if (rules.length === 0) return out;
  for (const id of tableIds) {
    const table = { name: bareTable(id), columns: columnsOf(graph, id) };
    const hit = rules.find((r) => r.compiled(table));
    if (hit) out.set(id, { rule: hit.id, joins: joinedTables(graph, id) });
  }
  return out;
}

/** Every table one route reaches, with the weakest grade on the way to each. */
function tablesOfEndpoint(graph, ep, stmtTables, mode) {
  const out = new Map();
  for (const s of ep.statements) {
    let tables = stmtTables.get(s.id);
    if (!tables) {
      tables = sqlEdgesOf(graph, s.id, mode).filter((e) => e.type === 'EXECUTES').map((e) => ({ id: e.to, grade: e.grade }));
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
 * @param {{mode?:string, depth?:number, packageDepth?:number|null, limit?:number, through?:string, joinRules?:object[]}} [opts]
 *        `through` names one route or table (a node id) whose paths the answer also carries;
 *        `joinRules` the `table.join-table` rules read (the engine's own packs when left out).
 */
export function buildSummary(graph, opts = {}) {
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : SUMMARY_LIMIT;
  const { endpoints, walk } = walkEndpoints(graph, { mode: opts.mode, depth: opts.depth, packageDepth: opts.packageDepth ?? null });
  const { rule, groupOf } = groupRule(graph, endpoints, opts.packageDepth ?? null, limit);
  const stmtTables = new Map();
  const reach = endpoints.map((ep) => [ep, tablesOfEndpoint(graph, ep, stmtTables, opts.mode ?? 'conservative')]);
  const allTables = [...new Set(reach.flatMap(([, t]) => [...t.keys()]))].sort(cmp);
  const joinTables = joinTablesOf(graph, allTables, opts.joinRules ?? builtinRegistry().ofKind('table.join-table'));
  const fam = familyRule(allTables, { limit, joinTables });
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
  const answer = summaryAnswer({ groups, families, pairs, rule: { groups: rule, tables: fam.rule }, limit, endpoints, walk });
  if (opts.through) answer.through = summaryThrough(opts.through, { reach, groupOf, familyOf: fam.familyOf, answer });
  return answer;
}

/** The box a group or a family is drawn in: its own, or the folded one. */
const boxOf = (kept, name) => (kept.has(name) ? name : OTHERS);

/**
 * THE PATHS THROUGH ONE ROUTE OR ONE TABLE (RM67-U2c), from the same walk as the
 * boxes, so a reader who picks one node sees only the lines that run through it.
 * A route: the families it reaches, each with its tables there and the weakest
 * grade on the way. A table: the groups whose routes reach it, each with those
 * routes and the weakest grade. Each is named by the box it is drawn in, the
 * folded `(others)` included. A route this walk did not start from, or a table
 * no route reaches, has no line: `links` is empty and its box is null.
 *
 * @param {string} node  `endpoint:<route>` or `table:<name>`
 */
export function summaryThrough(node, { reach, groupOf, familyOf, answer }) {
  const groups = new Set(answer.groups.map((g) => g.name));
  const families = new Set(answer.families.map((f) => f.name));
  const links = new Map();
  const add = (box, key, member, grade) => {
    if (!links.has(box)) links.set(box, { [key]: box, members: [], grade: null });
    const l = links.get(box);
    l.members.push(member);
    l.grade = weakest(l.grade, grade);
  };
  if (node.startsWith('endpoint:')) {
    const hit = reach.find(([ep]) => ep.id === node);
    for (const [tableId, grade] of hit ? hit[1] : []) add(boxOf(families, familyOf.get(tableId)), 'family', tableId, grade);
    return { node, group: hit ? boxOf(groups, groupOf.get(node)) : null, links: throughLinks(links, 'family', 'tables') };
  }
  for (const [ep, tables] of reach) if (tables.has(node)) add(boxOf(groups, groupOf.get(ep.id)), 'group', ep.id, tables.get(node));
  return { node, family: familyOf.has(node) ? boxOf(families, familyOf.get(node)) : null, links: throughLinks(links, 'group', 'endpoints') };
}

/** The links of one node, by box name, each with its members sorted under their own name. */
function throughLinks(links, key, field) {
  return [...links.values()]
    .map((l) => ({ [key]: l[key], [field]: [...l.members].sort(cmp), grade: l.grade }))
    .sort((a, b) => cmp(a[key], b[key]));
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
