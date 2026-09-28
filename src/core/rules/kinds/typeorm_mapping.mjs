// typeorm_mapping.mjs — the tables and columns TypeORM entities map, read from their decorators the way TypeORM's metadata builders read them.
//
// A class is an entity when a decorator the pack names (typeorm's @Entity)
// marks it. Its columns are the properties a column decorator marks, its own
// and those of every class it extends in the project (TypeORM reads the whole
// prototype chain; the nearest declaration of a property wins). A relation adds
// columns only on its owning side: a @ManyToOne always, a @OneToOne with
// @JoinColumn, and a @ManyToMany with @JoinTable adds a join table of its own.
//
// Every name is `{name, grade, why}`. A name the decorator writes is EXACT. A
// name the strategy derives is EXACT when the strategy is known and every
// TypeORM version spells it the same, HEURISTIC otherwise, with the reason.
// What cannot be read (an options object held in a variable, an embedded
// entity, a relation whose target is not an entity of the project) is listed in
// `notRead` and draws nothing.

import { externalOf } from './ts_names.mjs';

const RANK = Object.freeze({ EXACT: 3, SOUND_SET: 2, HEURISTIC: 1 });
export const weakest = (...gs) => gs.reduce((a, b) => (RANK[a] <= RANK[b] ? a : b), 'EXACT');

/** The decorators of one class or property that are TypeORM's, by the name TypeORM exports: `{name, args}`. */
function typeormDecorators(project, file, decorators, packages) {
  return decorators.map((d) => ({ ...d, ext: externalOf(project, file, d.name) }))
    .filter((d) => d.ext && packages.includes(d.ext.module)).map((d) => ({ name: d.ext.name, args: d.args }));
}

/** The options object among a decorator's arguments: the last object literal, or `{unread}` when one is not written out. */
function optionsArg(args) {
  const obj = [...args].reverse().find((a) => a.k === 'obj');
  if (obj) return obj.spread || obj.computed ? { unread: true, v: obj.v } : { v: obj.v };
  return args.some((a) => a.k === 'id' || a.k === 'member' || a.k === 'call') ? { unread: true, v: {} } : { v: {} };
}

const strOf = (v) => (v && v.k === 'str' ? v.v : null);

/** A class the entity decorator marks: `{given, schema, unread}` from `@Entity('name')`, `@Entity({ name, schema })` or `@Entity('name', { schema })`. */
function entityDeclOf(decorator) {
  const [a0] = decorator.args;
  const opts = optionsArg(decorator.args);
  const given = a0 && a0.k === 'str' ? a0.v : strOf(opts.v.name);
  const unread = opts.unread || (a0 && !['str', 'obj', 'none'].includes(a0.k)) || (opts.v.name && !strOf(opts.v.name));
  return { given, schema: strOf(opts.v.schema), unread: Boolean(unread) };
}

/** A relation's target class, as written: `() => User`, `type => User`, `User`, or the entity name as a string. */
function relationTarget(a0) {
  const v = a0 && a0.k === 'fn' ? a0.returns : a0;
  if (!v) return null;
  if (v.k === 'id') return { name: v.v };
  if (v.k === 'str') return { entityName: v.v };
  return null;
}

/** The inverse side a relation names: `(c) => c.article` or 'article'. */
function inverseOf(a1) {
  if (!a1) return null;
  if (a1.k === 'str') return a1.v;
  const r = a1.k === 'fn' ? a1.returns : null;
  return r && r.k === 'member' ? r.v.split('.').slice(1).join('.') : null;
}

/** `@JoinColumn()`, `@JoinColumn({ name, referencedColumnName })` or a list of them: the entries, or null when not written out. */
function joinColumnsOf(d) {
  if (!d) return null;
  const a0 = d.args[0];
  if (!a0 || a0.k === 'none') return [];
  const one = (o) => (o.k === 'obj' && !o.spread && !o.computed ? { name: strOf(o.v.name), referenced: strOf(o.v.referencedColumnName) } : undefined);
  const list = a0.k === 'arr' ? a0.v.map(one) : [one(a0)];
  return list.includes(undefined) ? { unread: true } : list;
}

/** `@JoinTable({ name, schema, joinColumn(s), inverseJoinColumn(s) })`. */
function joinTableOf(d) {
  if (!d) return null;
  const a0 = d.args[0];
  if (!a0 || a0.k === 'none') return { name: null, schema: null, joinColumns: [], inverseJoinColumns: [] };
  if (a0.k !== 'obj' || a0.spread || a0.computed) return { unread: true };
  const cols = (single, many) => {
    const v = a0.v[many] ?? a0.v[single];
    return v ? joinColumnsOf({ args: [v] }) : [];
  };
  return { name: strOf(a0.v.name), schema: strOf(a0.v.schema), joinColumns: cols('joinColumn', 'joinColumns'), inverseJoinColumns: cols('inverseJoinColumn', 'inverseJoinColumns') };
}

/** One property's reading: a column, a relation, something not read, or nothing of TypeORM's. */
function propertyOf(field, decorators, cfg) {
  const col = decorators.find((d) => Object.hasOwn(cfg.columns, d.name));
  if (col) {
    if (col.args[0] && col.args[0].k === 'fn') return { notRead: 'an embedded entity, whose columns are not read' };
    const opts = optionsArg(col.args);
    const primary = cfg.columns[col.name] === 'primary' || (opts.v.primary && opts.v.primary.k === 'bool' && opts.v.primary.v === true);
    const nameUnread = opts.unread || (opts.v.name && !strOf(opts.v.name));
    // `select: false` keeps a column out of every select that does not name it (TypeORM's ColumnMetadata.isSelect).
    const hidden = opts.v.select && opts.v.select.k === 'bool' && opts.v.select.v === false;
    return { column: { property: field.name, given: strOf(opts.v.name), nameUnread: Boolean(nameUnread), pk: Boolean(primary), deleteDate: cfg.columns[col.name] === 'delete-date', select: !hidden, line: field.line } };
  }
  const rel = decorators.find((d) => Object.hasOwn(cfg.relations, d.name));
  if (!rel) return null;
  const opts = optionsArg(rel.args);
  const eager = opts.v[cfg.eagerKey];
  return {
    relation: {
      property: field.name, kind: cfg.relations[rel.name], target: relationTarget(rel.args[0]), inverse: inverseOf(rel.args[1]?.k === 'obj' ? null : rel.args[1]),
      eager: !eager ? (opts.unread ? 'may' : false) : eager.k === 'bool' ? eager.v === true : 'may',
      joinColumns: joinColumnsOf(decorators.find((d) => d.name === cfg.joinColumn)), joinTable: joinTableOf(decorators.find((d) => d.name === cfg.joinTable)),
      line: field.line,
    },
  };
}

/** The properties TypeORM reads off a class: its own and every ancestor's in the project, nearest declaration first. */
function propertiesOf(project, cls, cfg) {
  const seen = new Set();
  const out = { columns: [], relations: [], notRead: [] };
  for (const c of project.lineage(cls)) {
    for (const field of c.fields.values()) {
      if (seen.has(field.name) || field.kind !== 'property') continue;
      seen.add(field.name);
      const p = propertyOf(field, typeormDecorators(project, c.file, field.decorators, cfg.packages), cfg);
      if (p?.column) out.columns.push(p.column);
      else if (p?.relation) out.relations.push(p.relation);
      else if (p?.notRead) out.notRead.push({ property: field.name, reason: p.notRead });
    }
  }
  return out;
}

/** Every class an entity decorator marks, and every class a decorator this pack does not read marks: `{entities, notRead}`. */
export function entityClasses(project, cfg) {
  const entities = [];
  const notRead = [];
  for (const f of project.files.values()) {
    for (const cls of f.classes.values()) {
      const decs = typeormDecorators(project, cls.file, cls.decorators, cfg.packages);
      const unreadDec = decs.find((d) => cfg.notRead.includes(d.name));
      const entity = decs.find((d) => cfg.entity.includes(d.name));
      if (unreadDec) notRead.push({ entity: cls.name, file: cls.file, reason: `@${unreadDec.name} is not read` });
      else if (entity) entities.push({ cls, decl: entityDeclOf(entity), ...propertiesOf(project, cls, cfg) });
    }
  }
  return { entities, notRead };
}
