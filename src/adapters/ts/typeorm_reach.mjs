// typeorm_reach.mjs — the edges of one TypeORM statement, and the relations it loads with its rows.
//
// A statement's edges are collected before they are drawn, one per target and
// type, the strongest kept: a column the where reads and the whole row returns
// is one READS edge. Every edge is capped at the receiver's grade and at the
// grades of the names it lands on, so a column whose name was derived under an
// assumed naming strategy is read at HEURISTIC, however sure the call is.
//
// A relation is followed the way TypeORM joins it: the owning side's join
// column and the key it references, or, for a @ManyToMany, the join table and
// its two columns; from the side that does not own it, through the relation
// its inverse names on the other side. Eager relations are followed from the
// entity a find returns, and from each entity that brings, as TypeORM's
// joinEagerRelations does, at most eight deep and never twice into one entity.

import { weakest } from '../../core/rules/kinds/typeorm_mapping.mjs';

const RANK = Object.freeze({ EXACT: 4, SOUND_SET: 3, HEURISTIC: 2, RUNTIME_ONLY: 1, UNRESOLVED: 0 });
const MAX_DEPTH = 8;

/** One statement's edges, gathered: `table`, `column`, `unresolved`, and `flush` to draw them. */
export function statementEdges(ctx) {
  const edges = new Map();
  const unresolved = [];
  const add = (type, to, grade, evidence) => {
    const k = `${type}|${to}`;
    const cur = edges.get(k);
    if (!cur || RANK[grade] > RANK[cur.grade]) edges.set(k, { type, to, grade, evidence });
  };
  const schemaOf = (x) => x.schema ?? ctx.schemaName ?? null;
  const table = (x, access, grade, evidence = {}) => {
    add('EXECUTES', ctx.nodes.tableId(schemaOf(x), x.table), weakest(ctx.cap, grade, x.tableGrade ?? x.grade), { access, via: 'typeorm', operation: ctx.operation, ...evidence });
  };
  const column = (x, col, type, grade, evidence) => {
    if (!col) return;
    add(type, ctx.nodes.columnId(schemaOf(x), x.table, col.column), weakest(ctx.cap, grade, x.tableGrade ?? x.grade, col.grade), { via: 'typeorm', operation: ctx.operation, ...(evidence ?? {}) });
  };
  const flush = (g, sid) => {
    for (const e of [...edges.values()].sort((a, b) => (a.type + a.to < b.type + b.to ? -1 : 1))) g.addEdge({ from: sid, to: e.to, type: e.type, grade: e.grade, evidence: e.evidence });
  };
  return { table, column, unresolved, flush, ctx };
}

const selectable = (e) => e.columns.filter((c) => c.select !== false);
const byColumn = (e, name) => e.columns.find((c) => c.column === name) ?? null;

/** Every column of an entity a select of its whole row returns. */
export function readWholeRow(se, e, grade, evidence) {
  for (const c of selectable(e)) se.column(e, c, 'READS', grade, evidence);
}

/** The join table a @ManyToMany goes through, from either side. */
function junctionOf(rel) {
  if (rel.junction) return rel.junction;
  const inv = rel.target?.relations.find((r) => r.property === rel.inverse && r.junction);
  return inv ? inv.junction : null;
}

function readJoin(se, e, rel, grade, evidence) {
  if (rel.kind === 'many-to-many') {
    const j = junctionOf(rel);
    if (!j) return false;
    se.table(j, 'read', grade, evidence);
    for (const c of [...j.ownerColumns, ...j.inverseColumns]) se.column(j, c, 'READS', grade, evidence);
    return true;
  }
  if (rel.owner) {
    for (const jc of rel.joinColumns) { se.column(e, jc, 'READS', grade, evidence); se.column(rel.target, byColumn(rel.target, jc.referenced), 'READS', grade, evidence); }
    return rel.joinColumns.length > 0;
  }
  const inv = rel.target.relations.find((r) => r.property === rel.inverse && r.owner);
  if (!inv) return false;
  for (const jc of inv.joinColumns) { se.column(rel.target, jc, 'READS', grade, evidence); se.column(e, byColumn(e, jc.referenced), 'READS', grade, evidence); }
  return inv.joinColumns.length > 0;
}

/** One relation followed: its join and its target's table, and the target's whole row when the rows bring it. Null when it cannot be followed. */
export function followRelation(se, e, rel, how) {
  const evidence = { rule: how.rule, path: `${e.name}.${rel.property}` };
  if (!rel.target || !readJoin(se, e, rel, how.grade, evidence)) {
    se.unresolved.push({ reason: 'relation-not-followed', detail: `${e.name}.${rel.property}: its join is not one this engine read` });
    return null;
  }
  se.table(rel.target, 'read', how.grade, evidence);
  if (how.whole) readWholeRow(se, rel.target, how.grade, evidence);
  return rel.target;
}

/**
 * A relation path the find options name (`articles.comments`), followed a
 * relation at a time, and the eager relations of each entity it brings:
 * TypeORM joins them with it (0.2's FindOptionsUtils.applyRelationsRecursively,
 * 0.3's buildEagerRelations). One level at `how.eager`; past it SOUND_SET,
 * since 0.2 follows theirs as well and 0.3 stops at one.
 */
export function followPath(se, e, path, how) {
  let cur = e;
  for (const prop of path.split('.')) {
    const rel = cur.relations.find((r) => r.property === prop);
    cur = rel ? followRelation(se, cur, rel, how) : null;
    if (!cur) { if (!rel) se.unresolved.push({ reason: 'argument-not-read', detail: `relations: ${path}` }); return; }
    if (how.eager) followEagerOnce(se, cur, how);
  }
}

/** The eager relations of an entity a named relation brought: the first level at `how.eager`, the rest SOUND_SET. */
function followEagerOnce(se, e, how) {
  for (const rel of e.relations) {
    if (!rel.eager || !rel.target) continue;
    const grade = rel.eager === 'may' ? weakest(how.eager, 'SOUND_SET') : how.eager;
    const target = followRelation(se, e, rel, { ...how, grade, whole: true, rule: 'typeorm-eager-relation' });
    if (target) followEager(se, target, { ...how, grade: 'SOUND_SET', rule: 'typeorm-eager-relation' }, new Set([e.key, target.key]));
  }
}

/** The eager relations of an entity a find returns, and theirs, as TypeORM joins them. */
export function followEager(se, e, how, seen = new Set([e.key]), depth = 0) {
  if (depth >= MAX_DEPTH) return;
  for (const rel of e.relations) {
    if (!rel.eager || !rel.target || seen.has(rel.target.key)) continue;
    const grade = rel.eager === 'may' ? weakest(how.grade, 'SOUND_SET') : how.grade;
    // A join that selects nothing (a count's) reads the relation's key and join column, not its row.
    const target = followRelation(se, e, rel, { ...how, grade, whole: !how.joinOnly });
    if (target) followEager(se, target, { ...how, grade }, new Set([...seen, target.key]), depth + 1);
  }
}
