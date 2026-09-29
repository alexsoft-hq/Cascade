// typeorm_model.mjs — the entity model: every entity's table, columns and relations with their physical names, and every join table, each name graded.
//
// The raw reading of the decorators is typeorm_mapping.mjs; which strategy
// names what is typeorm_options.mjs and typeorm_naming.mjs. Here they meet, in
// the order TypeORM builds its metadata: tables and columns first, then the
// join columns a relation adds (they name the referenced entity's primary
// key), then the join tables (they name both tables and both keys).

import { weakest } from './typeorm_mapping.mjs';
import { pathOf } from './typeorm_path.mjs';

/** The grade and reason of a name: EXACT when the source wrote it, else what its derivation rests on. */
function gradeOf(derived, decision, extra = []) {
  if (derived.given && extra.length === 0) return { grade: 'EXACT', why: 'written in the source' };
  const why = [...extra];
  if (!derived.given && !decision.known) why.push(`derived by ${decision.strategy.name} naming, assumed: ${decision.reason}`);
  if (!derived.given && derived.varies) why.push(`the installed TypeORM decides it: ${derived.varies}`);
  return why.length > 0 ? { grade: 'HEURISTIC', why: why.join('; ') } : { grade: 'EXACT', why: `derived by ${decision.strategy.name} naming, which the ${decision.declared?.includes('namingStrategy') ? 'profile declares' : 'options name'}` };
}

const prefixed = (decision, base) => (decision.prefix ? `${decision.prefix}${base}` : base);

/**
 * A table's qualifier, and why its real name may be another whatever the
 * decorator writes: the DataSource's entityPrefix goes before every table
 * name, and what qualifies it is the driver's (typeorm_path.mjs).
 */
function tablePlace(decision, naming, own) {
  const path = pathOf(decision, naming.tablePath, own);
  const prefix = decision.prefixKnown ? [] : [`the DataSource entityPrefix, which goes before every table name, is not known: ${decision.prefixWhy}`];
  return { qualifier: path.qualifier || null, doubts: [...prefix, ...path.doubts] };
}

function entityOf(raw, decision, naming) {
  const s = decision.strategy;
  const t = naming.table(s, raw.cls.name, raw.decl.given);
  const place = tablePlace(decision, naming, raw.decl);
  const tg = gradeOf(t, decision, [...(raw.decl.unread ? ['the entity options are not written out, and may name another table'] : []), ...place.doubts]);
  const columns = raw.columns.map((c) => {
    const n = naming.column(s, c.property, c.given);
    const g = gradeOf(n, decision, c.nameUnread ? ['the column options are not written out, and may name another column'] : []);
    return { property: c.property, column: n.name, grade: g.grade, why: g.why, pk: c.pk, deleteDate: c.deleteDate, select: c.select, line: c.line, ...(c.auto ? { role: c.role, auto: c.auto, insertable: c.insertable } : {}) };
  });
  return {
    key: raw.cls.key, name: raw.cls.name, file: raw.cls.file, line: raw.cls.line, schema: place.qualifier, own: { schema: raw.decl.schema, database: raw.decl.database },
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

/** The name of the join column that references `rc`: the one the options write, else the strategy's, graded. */
function joinColumnName(rel, rc, unread, decision, naming) {
  const jc = unread ? null : (rel.joinColumns ?? []).find((j) => (!j.referenced || j.referenced === rc.property) && (j.name || j.nameUnread));
  const n = jc?.name ? { name: jc.name, given: true } : naming.joinColumn(decision.strategy, rel.property, rc.property);
  const held = unread || jc?.nameUnread ? ['the join column options are not written out, and may name another column'] : [];
  return { n, g: gradeOf(n, decision, held) };
}

/** The join columns an owning @ManyToOne or @OneToOne adds to its entity. */
function addJoinColumns(e, rel, target, decision, naming) {
  const unread = rel.joinColumns && rel.joinColumns.unread;
  const refs = referencedColumns(target, unread ? [] : rel.joinColumns);
  if (refs.includes(null)) { e.notRead.push({ property: rel.property, reason: 'a referencedColumnName that is not a column of the target' }); return []; }
  return refs.map((rc) => {
    const { n, g } = joinColumnName(rel, rc, unread, decision, naming);
    const existing = e.columns.find((c) => c.column === n.name);
    if (existing) return existing;
    const col = { property: rel.property, column: n.name, grade: g.grade, why: g.why, pk: false, deleteDate: false, select: true, join: rel.property, referenced: rc.column, line: rel.line };
    e.columns.push(col);
    return col;
  });
}

function junctionColumns(side, entity, refs, joinColumns, ctx) {
  return refs.map((rc) => {
    const jc = (joinColumns ?? []).find((j) => (!j.referenced || j.referenced === rc.property) && (j.name || j.nameUnread));
    const n = jc?.name ? { name: jc.name, given: true } : ctx.naming.joinTableColumn(ctx.decision.strategy, entity.tableBase, rc.column);
    const g = gradeOf(n, ctx.decision, jc?.nameUnread ? ['the join column name is held in a value this engine does not read'] : []);
    return { column: n.name, grade: jc?.name ? g.grade : weakest(g.grade, entity.tableGrade, rc.grade), why: g.why, side, referenced: rc.column };
  });
}

/** Why a join table's name may be another: too long for some driver, held in a value, or a prefix or schema not known. */
function joinTableDoubts(e, jt, n, decision, naming) {
  const long = !n.given && n.name.length > naming.joinTableNameLimit ? [`it is longer than ${naming.joinTableNameLimit} characters, and a driver whose alias limit is shorter shortens it`] : [];
  const held = jt.nameUnread ? ['the join table name or schema is held in a value this engine does not read'] : [];
  return [...long, ...held, ...tablePlace(decision, naming, junctionOwn(e, jt)).doubts];
}

/** What a join table writes itself, else its owner's (JunctionEntityMetadataBuilder: `joinTable.schema || relation.entityMetadata.schema`, the same for the database). */
const junctionOwn = (e, jt) => ({ schema: jt.schema ?? e.own.schema, database: jt.database ?? e.own.database });

/** The join table an owning @ManyToMany with @JoinTable adds. */
function junctionOf(e, rel, target, decision, naming) {
  const jt = rel.joinTable;
  if (jt.unread) { e.notRead.push({ property: rel.property, reason: 'the join table options are not written out' }); return null; }
  const n = jt.name ? { name: jt.name, given: true } : naming.joinTable(decision.strategy, e.tableBase, rel.property, target.tableBase);
  const g = gradeOf(n, decision, joinTableDoubts(e, jt, n, decision, naming));
  const ctx = { naming, decision };
  const ownerColumns = junctionColumns('owner', e, referencedColumns(e, jt.joinColumns), jt.joinColumns, ctx);
  const inverseColumns = junctionColumns('inverse', target, referencedColumns(target, jt.inverseJoinColumns), jt.inverseJoinColumns, ctx);
  for (const oc of ownerColumns) {
    const clash = inverseColumns.find((ic) => ic.column === oc.column);
    if (clash) { oc.column = `${oc.column}_1`; clash.column = `${clash.column}_2`; }
  }
  return {
    table: prefixed(decision, n.name), tableBase: n.name, schema: tablePlace(decision, naming, junctionOwn(e, jt)).qualifier, grade: n.given ? g.grade : weakest(g.grade, e.tableGrade, target.tableGrade),
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
  return { entities, junctions, notRead: raw.notRead, naming: decision, driverDoubt: driverDoubtOf(decision, naming, raw, entities) };
}

/** Why the driver leaves a table's name in doubt, from the first table it does: the DataSource type not known, or not one the pack names. */
function driverDoubtOf(decision, naming, raw, entities) {
  const owns = raw.entities.flatMap((r) => {
    const e = entities.get(r.cls.key);
    return [e.own, ...r.relations.filter((rel) => rel.joinTable && !rel.joinTable.unread).map((rel) => junctionOwn(e, rel.joinTable))];
  });
  return owns.map((own) => pathOf(decision, naming.tablePath, own).driver).find(Boolean) ?? null;
}

/** The entity of a property path's relation, or null. */
export const relationNamed = (e, property) => e.relations.find((r) => r.property === property) ?? null;

/** The weakest grade of an entity's names: its table's and every column's. */
export const weakestOfEntity = (e) => weakest(e.tableGrade, ...e.columns.map((c) => c.grade));
