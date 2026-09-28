// typeorm_model.mjs — the entity model: every entity's table, columns and relations with their physical names, and every join table, each name graded.
//
// The raw reading of the decorators is typeorm_mapping.mjs; which strategy
// names what is typeorm_options.mjs and typeorm_naming.mjs. Here they meet, in
// the order TypeORM builds its metadata: tables and columns first, then the
// join columns a relation adds (they name the referenced entity's primary
// key), then the join tables (they name both tables and both keys).

import { weakest } from './typeorm_mapping.mjs';

/** The grade and reason of a name: EXACT when the source wrote it, else what its derivation rests on. */
function gradeOf(derived, decision, extra = []) {
  if (derived.given && extra.length === 0) return { grade: 'EXACT', why: 'written in the source' };
  const why = [...extra];
  if (!derived.given && !decision.known) why.push(`derived by ${decision.strategy.name} naming, assumed: ${decision.reason}`);
  if (!derived.given && derived.varies) why.push(`the installed TypeORM decides it: ${derived.varies}`);
  return why.length > 0 ? { grade: 'HEURISTIC', why: why.join('; ') } : { grade: 'EXACT', why: `derived by ${decision.strategy.name} naming, which the ${decision.declared ? 'profile declares' : 'options name'}` };
}

const prefixed = (decision, base) => (decision.prefix ? `${decision.prefix}${base}` : base);

function entityOf(raw, decision, naming) {
  const s = decision.strategy;
  const t = naming.table(s, raw.cls.name, raw.decl.given);
  const tg = gradeOf(t, decision, raw.decl.unread ? ['the entity options are not written out, and may name another table'] : []);
  const columns = raw.columns.map((c) => {
    const n = naming.column(s, c.property, c.given);
    const g = gradeOf(n, decision, c.nameUnread ? ['the column options are not written out, and may name another column'] : []);
    return { property: c.property, column: n.name, grade: g.grade, why: g.why, pk: c.pk, deleteDate: c.deleteDate, select: c.select, line: c.line };
  });
  return {
    key: raw.cls.key, name: raw.cls.name, file: raw.cls.file, line: raw.cls.line, schema: raw.decl.schema,
    tableBase: t.name, table: prefixed(decision, t.name), tableGrade: tg.grade, tableWhy: tg.why,
    columns, relations: [], notRead: [...raw.notRead],
  };
}

/** The entity a relation's target names: a class of the project by the name written in the entity's file, or an entity by its name. */
function targetOf(project, e, target, entities) {
  if (!target) return null;
  if (target.name) {
    const cls = project.classOf(e.file, target.name);
    return cls ? entities.get(cls.key) ?? null : null;
  }
  const hits = [...entities.values()].filter((x) => x.name === target.entityName || x.table === target.entityName);
  return hits.length === 1 ? hits[0] : null;
}

/** The columns a list of join column options references: the named ones, else the target's primary key, as TypeORM's builders choose. */
function referencedColumns(target, joinColumns) {
  const named = (joinColumns ?? []).filter((j) => j.referenced);
  if (named.length === 0) return target.columns.filter((c) => c.pk);
  return named.map((j) => target.columns.find((c) => c.property === j.referenced) ?? null);
}

/** The join columns an owning @ManyToOne or @OneToOne adds to its entity. */
function addJoinColumns(e, rel, target, decision, naming) {
  const unread = rel.joinColumns && rel.joinColumns.unread;
  const refs = referencedColumns(target, unread ? [] : rel.joinColumns);
  if (refs.includes(null)) { e.notRead.push({ property: rel.property, reason: 'a referencedColumnName that is not a column of the target' }); return []; }
  return refs.map((rc) => {
    const jc = unread ? null : (rel.joinColumns ?? []).find((j) => (!j.referenced || j.referenced === rc.property) && j.name);
    const n = jc ? { name: jc.name, given: true } : naming.joinColumn(decision.strategy, rel.property, rc.property);
    const g = gradeOf(n, decision, unread ? ['the join column options are not written out, and may name another column'] : []);
    const existing = e.columns.find((c) => c.column === n.name);
    if (existing) return existing;
    const col = { property: rel.property, column: n.name, grade: g.grade, why: g.why, pk: false, deleteDate: false, select: true, join: rel.property, referenced: rc.column, line: rel.line };
    e.columns.push(col);
    return col;
  });
}

function junctionColumns(side, entity, refs, joinColumns, ctx) {
  return refs.map((rc) => {
    const jc = (joinColumns ?? []).find((j) => (!j.referenced || j.referenced === rc.property) && j.name);
    const n = jc ? { name: jc.name, given: true } : ctx.naming.joinTableColumn(ctx.decision.strategy, entity.tableBase, rc.column);
    const g = gradeOf(n, ctx.decision);
    return { column: n.name, grade: jc ? 'EXACT' : weakest(g.grade, entity.tableGrade, rc.grade), why: g.why, side, referenced: rc.column };
  });
}

/** The join table an owning @ManyToMany with @JoinTable adds. */
function junctionOf(e, rel, target, decision, naming) {
  const jt = rel.joinTable;
  if (jt.unread) { e.notRead.push({ property: rel.property, reason: 'the join table options are not written out' }); return null; }
  const n = jt.name ? { name: jt.name, given: true } : naming.joinTable(decision.strategy, e.tableBase, rel.property, target.tableBase);
  const long = !n.given && n.name.length > naming.joinTableNameLimit ? [`it is longer than ${naming.joinTableNameLimit} characters, and a driver whose alias limit is shorter shortens it`] : [];
  const g = gradeOf(n, decision, long);
  const ctx = { naming, decision };
  const ownerColumns = junctionColumns('owner', e, referencedColumns(e, jt.joinColumns), jt.joinColumns, ctx);
  const inverseColumns = junctionColumns('inverse', target, referencedColumns(target, jt.inverseJoinColumns), jt.inverseJoinColumns, ctx);
  for (const oc of ownerColumns) {
    const clash = inverseColumns.find((ic) => ic.column === oc.column);
    if (clash) { oc.column = `${oc.column}_1`; clash.column = `${clash.column}_2`; }
  }
  return {
    table: prefixed(decision, n.name), tableBase: n.name, schema: jt.schema ?? e.schema, grade: n.given ? 'EXACT' : weakest(g.grade, e.tableGrade, target.tableGrade),
    why: g.why, owner: e, target, property: rel.property, ownerColumns, inverseColumns,
  };
}

function relationOf(project, e, rel, ctx) {
  const target = targetOf(project, e, rel.target, ctx.entities);
  const r = { property: rel.property, kind: rel.kind, target, inverse: rel.inverse, eager: rel.eager, owner: false, joinColumns: [], junction: null, line: rel.line };
  if (!target) { e.notRead.push({ property: rel.property, reason: 'its target is not an entity this engine read' }); return r; }
  if (rel.kind === 'many-to-one' || (rel.kind === 'one-to-one' && rel.joinColumns !== null)) {
    r.owner = true;
    r.joinColumns = addJoinColumns(e, rel, target, ctx.decision, ctx.naming);
  } else if (rel.kind === 'many-to-many' && rel.joinTable !== null) {
    r.owner = true;
    r.junction = junctionOf(e, rel, target, ctx.decision, ctx.naming);
  }
  return r;
}

/**
 * The model: `{entities: Map<class key, entity>, junctions, notRead, naming}`.
 * An entity carries `table` (with the options' prefix), `tableBase` (without),
 * `schema`, `tableGrade`, and its `columns` and `relations`.
 */
export function buildModel(project, raw, decision, naming) {
  const entities = new Map(raw.entities.map((r) => [r.cls.key, entityOf(r, decision, naming)]));
  const ctx = { entities, decision, naming };
  // Join columns first: a join table names the primary key of both sides, and a key may itself be a join column.
  for (const r of raw.entities) {
    const e = entities.get(r.cls.key);
    e.relations = r.relations.filter((rel) => rel.kind !== 'many-to-many').map((rel) => relationOf(project, e, rel, ctx));
  }
  for (const r of raw.entities) {
    const e = entities.get(r.cls.key);
    e.relations.push(...r.relations.filter((rel) => rel.kind === 'many-to-many').map((rel) => relationOf(project, e, rel, ctx)));
  }
  const junctions = [...entities.values()].flatMap((e) => e.relations.map((r) => r.junction).filter(Boolean));
  return { entities, junctions, notRead: raw.notRead, naming: decision };
}

/** The entity of a property path's relation, or null. */
export const relationNamed = (e, property) => e.relations.find((r) => r.property === property) ?? null;

/** The weakest grade of an entity's names: its table's and every column's. */
export const weakestOfEntity = (e) => weakest(e.tableGrade, ...e.columns.map((c) => c.grade));
