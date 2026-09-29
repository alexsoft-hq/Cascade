// jpa_bridge.mjs — JPA entities and Spring Data repositories become graph facts
// (SPEC §3.1, §3.4, §8.3, §15 M10).
//
// The MyBatis lane has it easy: the SQL is written down, so a statement literally
// names its table and columns. JPA writes nothing down. The mapping from
// `Owner.lastName` to `owners.last_name` is produced at runtime by a naming
// STRATEGY, and the query behind `findByLastNameStartingWith` is produced from
// the METHOD NAME. This bridge reads both the same way Hibernate/Spring Data do,
// and — this is the whole point — it says which half of that it actually knows:
//
//   @Table(name="owners")  / @Column(name="visit_date")  -> EXACT, declared.
//   Owner -> owners by the strategy the PROFILE declares -> EXACT, declared.
//   Owner -> owners because the profile declares nothing and Spring Boot's
//            default is CamelCase -> snake_case                -> HEURISTIC.
//
// I-1 (MUST): a HEURISTIC mapping is NEVER promoted, and in particular a
// catalog hit does not promote it. That the guessed table name happens to exist
// in the DDL is recorded as `evidence.catalogMatch`, and nothing more: the
// coincidence is evidence for a human, not proof for the engine.
//
// Grades on statement -> table/column edges are the WEAKEST LINK of (the entity
// mapping, the attribute mapping, how the query part resolved), so a chain that
// leaned on an assumed naming strategy can never come back EXACT.
//
// AND A QUERY READS MORE TABLES THAN IT NAMES. `findById` on an Owner whose
// `pets` is `fetch = EAGER` issues one round trip that brings the pets back, and
// their `type` with them, because a @ManyToOne is eager unless the mapping says
// otherwise. So every statement whose result is an entity carries that closure,
// and the query's own plan (a JOIN FETCH, an @EntityGraph) overrides the
// mapping. LAZY stays out and is counted: a collection a page touches after the
// query has run is a real read, and it happens where this lane cannot see it.
// See `fetchClosure` below.
//
// Runs AFTER `addJavaFacts` (it needs the symbol nodes) and after the SQL
// bridge (it stitches onto the catalog's table/column nodes). Pure: a Graph and
// a fact array in, the same Graph mutated and a stats object out.

import { nodeId } from '../core/graph.mjs';
import { buildTypeIndex } from './java_bridge.mjs';
import { parseDerivedQuery, resolvePropertyPath } from '../core/derived_query.mjs';
import { readJpql } from '../core/jpql_lite.mjs';
import { tableKey, columnKey, statementKey, graphSpellingIndex } from './sql_bridge.mjs';

/**
 * The naming strategies this bridge can apply. `spring-snake-case` is Spring
 * Boot's default as a version-independent rule: where Hibernate 6 and 7 spell a
 * name differently it cannot say which, and grades the name HEURISTIC. The two
 * versioned ones are the rule a named implementation class fixes:
 * `snake-case-hibernate6` (Spring Boot 2's SpringPhysicalNamingStrategy, letters
 * only) and `snake-case-hibernate7` (PhysicalNamingStrategySnakeCaseImpl, which
 * exists from Hibernate 7.0 on and counts digits).
 */
export const NAMING_STRATEGIES = Object.freeze(['spring-snake-case', 'snake-case-hibernate6', 'snake-case-hibernate7', 'identity']);

/** What an undeclared `jpa.namingStrategy` is ASSUMED to be (Spring Boot's default). */
export const ASSUMED_NAMING_STRATEGY = 'spring-snake-case';

/**
 * The CrudRepository / JpaRepository methods a service can call without the
 * repository declaring them. `flush()` is deliberately absent: it forces the
 * persistence context to write what is already pending, it is not a query of its
 * own, and giving it a statement would invent a row-touching fact.
 */
export const BUILTIN_METHODS = Object.freeze({
  save: 'save', saveAll: 'save', saveAndFlush: 'save', saveAllAndFlush: 'save',
  delete: 'delete', deleteById: 'delete', deleteAll: 'delete', deleteAllById: 'delete',
  deleteAllInBatch: 'delete', deleteAllByIdInBatch: 'delete', deleteInBatch: 'delete',
  findById: 'findById', existsById: 'findById', getById: 'findById', getOne: 'findById',
  getReferenceById: 'findById',
  findAll: 'findAll', findAllById: 'findAll', count: 'findAll',
});

/** Cascade kinds that make a save() reach the associated rows. */
const SAVING_CASCADES = new Set(['ALL', 'PERSIST', 'MERGE']);

/** Cascade kinds that make a delete() reach the associated rows. */
const REMOVING_CASCADES = new Set(['ALL', 'REMOVE']);

/**
 * The associations JPA loads WITH their owner when the mapping does not say. The
 * specification's default, not a guess: a to-one is EAGER, a to-many is LAZY.
 */
const DEFAULT_EAGER_RELATIONS = new Set(['manyToOne', 'oneToOne']);

/**
 * How far one statement's fetch plan is followed before it is cut. Eight hops of
 * eager associations is already a query no reader expected; past that the answer
 * says it stopped rather than growing without end on a mapping that loops.
 */
const FETCH_DEPTH_CAP = 8;

/**
 * WHAT EACH FETCH RULE DID, in one sentence, for `evidence.basis`. All four are
 * read off the mapping or the query, so the RULE is exact; what the edge ends up
 * graded is the weakest link of that and the names it had to derive.
 */
export const JPA_FETCH_RULE_BASIS = Object.freeze({
  'jpa-eager-fetch': 'the association is fetched EAGERLY, so the row on the other side comes back with this one in the same round trip. `fetch = EAGER` when the mapping writes it, and the JPA default when it does not: a to-one is eager, a to-many is lazy',
  'jpql-join-fetch': 'the query itself writes JOIN FETCH along this association, so it is loaded whatever the mapping says about fetching it',
  'jpa-entity-graph': 'the repository method carries an @EntityGraph naming this attribute path, so it is loaded whatever the mapping says about fetching it',
  'jpa-cascade': 'the association cascades this operation, so saving or deleting the owner reaches the row on the other side. Whether a given call has a child to write is decided at run time, so the reach is a candidate set and never a proof',
});

const RANK = Object.freeze({ UNRESOLVED: 0, RUNTIME_ONLY: 1, HEURISTIC: 2, SOUND_SET: 3, EXACT: 4 });
const weakest = (...gs) => gs.reduce((a, b) => (RANK[a] <= RANK[b] ? a : b), 'EXACT');

/**
 * SPRING BOOT'S PHYSICAL NAMING, as Hibernate and Spring actually implement it
 * (Spring Boot 2's SpringPhysicalNamingStrategy, Hibernate's
 * CamelCaseToUnderscoresNamingStrategy and PhysicalNamingStrategySnakeCaseImpl):
 * a `.` becomes `_`; an underscore goes before an upper-case letter only when the
 * letter before it AND the letter after it are lower-case, and never before the
 * last character; then everything is lower-cased. So `lastName` is `last_name`,
 * but `myURLValue` is `myurlvalue` and `userID` is `userid`, because an acronym
 * has no lower-case letter on both sides.
 *
 * THE RULE CHANGED ONCE. Hibernate 7 (Spring Boot 4) also counts a DIGIT as a
 * lower-case letter on either side, so `address2Line` is `address2line` before it
 * and `address2_line` after it. Which one a project runs cannot be read from the
 * source, so a name the two rules spell differently is `versionDependent`, and
 * the bridge never grades it EXACT (see `derivedName`).
 * @param {string} logical
 * @returns {{name:string, versionDependent:boolean, hibernate7:string}}
 */
export function springPhysicalName(logical) {
  const s = String(logical ?? '').replace(/\./g, '_');
  const beforeSeven = underscored(s, (c) => /\p{Ll}/u.test(c)).toLowerCase();
  const hibernate7 = underscored(s, (c) => /[\p{Ll}\p{Nd}]/u.test(c)).toLowerCase();
  return { name: beforeSeven, versionDependent: beforeSeven !== hibernate7, hibernate7 };
}

/** The underscores Hibernate's loop inserts: before an upper-case letter between two `soft` characters, the last character excepted. */
function underscored(s, soft) {
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    if (i > 0 && i < s.length - 1 && soft(s[i - 1]) && /\p{Lu}/u.test(s[i]) && soft(s[i + 1])) out += '_';
    out += s[i];
  }
  return out;
}

/** Spring Boot's physical name for a logical one (the rule before Hibernate 7; see `springPhysicalName`). */
export const snakeCase = (name) => springPhysicalName(name).name;

/** The physical name a strategy gives a logical one. */
export const physicalName = (logical, strategy) => derivedName(logical, strategy, 'EXACT').name;

/**
 * A name the ENGINE derives, and its grade: the strategy's grade, except that a
 * name Hibernate 7 spells differently from the versions before it is HEURISTIC
 * whatever the profile declares, because the project's Hibernate version decides it.
 */
function derivedName(logical, strategy, derivedGrade) {
  if (strategy === 'identity') return { name: String(logical ?? ''), grade: derivedGrade };
  const n = springPhysicalName(logical);
  if (strategy === 'snake-case-hibernate7') return { name: n.hibernate7, grade: derivedGrade };
  if (strategy === 'snake-case-hibernate6') return { name: n.name, grade: derivedGrade };
  return { name: n.name, grade: n.versionDependent ? 'HEURISTIC' : derivedGrade };
}

/**
 * The `@Query(nativeQuery = true)` statements in a JavaFacts stream, in the
 * shape the SQL lane's own statement records have.
 *
 * PURE, and separate from `addJpaFacts` on purpose: `analyze` calls this BEFORE
 * building the graph so the SQL text goes through lineage.py — the same
 * analyzer, dialect, catalog and content-addressed shards as a MyBatis
 * statement. A native query is SQL; nothing about it should be read twice, by
 * two different readers, with two chances to disagree.
 *
 * @param {object[]} javaFacts
 * @returns {{kind:string, namespace:string, id:string, type:string, sql:string,
 *            file:(string|null), line:(number|null)}[]}
 */
export function nativeQueryStatements(javaFacts) {
  const out = [];
  for (const r of javaFacts ?? []) {
    if (!r || r.kind !== 'repository') continue;
    for (const m of r.methods ?? []) {
      const q = m.query;
      if (!q || q.native !== true || typeof q.text !== 'string' || q.text.trim().length === 0) continue;
      out.push({
        kind: 'statement',
        namespace: r.fqn,
        id: m.name,
        type: sqlVerbOf(q.text),
        // JPA bind markers are normalized to `?` first — exactly what
        // mybatis_extract.py does with `#{}`. `where city = ?1` is not valid SQL
        // in any dialect, so without this every parameterised native query would
        // come back `parse_failed` and touch nothing.
        sql: normalizeBindParameters(q.text),
        file: r.file ?? null,
        line: m.line ?? null,
      });
    }
  }
  // Deterministic: two methods of the same name (an overload) name one statement.
  const seen = new Set();
  return out
    .filter((s) => (seen.has(`${s.namespace}.${s.id}`) ? false : (seen.add(`${s.namespace}.${s.id}`), true)))
    .sort((a, b) => cmp(`${a.namespace}.${a.id}`, `${b.namespace}.${b.id}`));
}

/**
 * Replace JPA bind markers (`?1`, `:name`) with the plain `?` a SQL parser
 * accepts. String literals and comments are stepped over untouched, and a
 * Postgres `::type` cast is left alone — only a lone `:` starting an identifier
 * is a parameter.
 * @param {string} sql
 * @returns {string}
 */
export function normalizeBindParameters(sql) {
  const s = String(sql ?? '');
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "'" || c === '"' || c === '`') {
      // a quoted literal / identifier: copy it whole, doubling included
      const quote = c;
      let j = i + 1;
      while (j < s.length) {
        if (s[j] === quote && s[j + 1] === quote) { j += 2; continue; }
        if (s[j] === quote) { j += 1; break; }
        j += 1;
      }
      out += s.slice(i, j);
      i = j;
      continue;
    }
    if (c === '-' && s[i + 1] === '-') {
      const nl = s.indexOf('\n', i);
      const end = nl < 0 ? s.length : nl;
      out += s.slice(i, end);
      i = end;
      continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      const stop = end < 0 ? s.length : end + 2;
      out += s.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === '?' && /[0-9]/.test(s[i + 1] ?? '')) {
      out += '?';
      i += 1;
      while (i < s.length && /[0-9]/.test(s[i])) i += 1;
      continue;
    }
    if (c === ':' && s[i + 1] !== ':' && s[i - 1] !== ':' && /[A-Za-z_]/.test(s[i + 1] ?? '')) {
      out += '?';
      i += 1;
      while (i < s.length && /[A-Za-z0-9_]/.test(s[i])) i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** The statement type lineage.py expects, read off the SQL's leading verb. */
function sqlVerbOf(sql) {
  const m = /^\s*(?:\/\*[\s\S]*?\*\/\s*|--[^\n]*\n\s*)*([a-zA-Z]+)/.exec(String(sql));
  const verb = m ? m[1].toLowerCase() : '';
  if (verb === 'insert') return 'insert';
  if (verb === 'update') return 'update';
  if (verb === 'delete') return 'delete';
  return 'select';
}

/**
 * Add JPA / Spring Data facts to a graph that already carries the SQL catalog
 * and the Java lane's symbols.
 *
 * @param {import('../core/graph.mjs').Graph} g
 * @param {object[]} javaFacts  cascade:javafacts:3 records
 * @param {{namingStrategy?:(string|null), schema?:(string|null),
 *          identifierCase?:(string|null)}} [opts]
 *        `namingStrategy` null means the profile declares none — the bridge then
 *        assumes Spring Boot's default and grades every name it derived HEURISTIC.
 *        `identifierCase` is the SQL identity rule this run matched names with —
 *        the SAME one the lineage worker and the SQL bridge were given. Without
 *        it, a project whose DDL is upper case (Oracle, HSQLDB, H2) gets TWO
 *        column nodes for one column: the DDL's `ID` and the strategy's `id`.
 * @returns {{entities:number, mappedSuperclasses:number, repositories:number,
 *            tables:number, tablesStubbed:number, columns:number, columnsStubbed:number,
 *            joins:number, statements:number, statementsByType:Object,
 *            implementsStmt:number, unresolvedStatements:number, unresolved:Object[],
 *            builtins:number, namingStrategy:string, namingStrategyDeclared:boolean}}
 */
/**
 * 1. ENTITIES -> TABLES. A name the SOURCE wrote down is EXACT; a name this
 * engine DERIVED is EXACT only where the project declared the naming strategy it
 * was derived by, and HEURISTIC otherwise.
 */
function entityTables(entityRecords, { strategy, derivedGrade, namingEvidence, stats, resolveType }) {
// ---- 1. entities -> tables ----------------------------------------------
/** @type {Map<string, {fqn, table, tableId, grade, attributes:Map, pkColumn}>} */
const entities = new Map();
for (const [fqn, rec] of entityRecords) {
  if (rec.mappedSuperclass === true) stats.mappedSuperclasses += 1;
  if (rec.entity !== true) continue; // @MappedSuperclass / @Embeddable map to no table
  stats.entities += 1;
  const simple = fqn.slice(fqn.lastIndexOf('.') + 1);
  // `@Entity(name = "Hound")` renames the entity, and the default table is
  // derived from that name, not from the class's (javafacts/21).
  const entityName = typeof rec.entityName === 'string' && rec.entityName.length > 0 ? rec.entityName : simple;
  const explicit = typeof rec.tableName === 'string' && rec.tableName.length > 0;
  const derived = derivedName(entityName, strategy, derivedGrade);
  const table = explicit ? rec.tableName : derived.name;
  entities.set(fqn, {
    fqn, simple, entityName, record: rec,
    table,
    tableGrade: explicit ? 'EXACT' : derived.grade,
    tableEvidence: explicit ? 'declared' : namingEvidence,
    attributes: null, // filled below, once the superclass chain is walked
    pkColumn: null,
    // Columns on THIS table that another entity's association declares — the
    // foreign key a unidirectional @OneToMany(@JoinColumn) puts on the target.
    // They are as much part of the row as the entity's own attributes, so a
    // `save()` writes them and a `findAll()` reads them.
    inboundColumns: [],
    // The hierarchy (see `placeHierarchies`): the nearest entity this one
    // extends, the strategy its root's @Inheritance names, and the entities
    // that extend this one directly.
    parent: null,
    inheritance: null,
    subclasses: [],
  });
}

  placeHierarchies(entities, entityRecords, resolveType, stats);
  return entities;
}

/** The @Inheritance strategies this bridge reads; the JPA default is SINGLE_TABLE. */
const INHERITANCE_STRATEGIES = new Set(['SINGLE_TABLE', 'JOINED', 'TABLE_PER_CLASS']);

/**
 * WHERE A SUBCLASS'S ROWS LIVE. An entity that extends another entity (through
 * any @MappedSuperclass between them) is part of that entity's hierarchy, and
 * the ROOT's @Inheritance says how the hierarchy is stored:
 *
 *   SINGLE_TABLE (the default) -> every row is in the root's table; a subclass
 *     has no table of its own, and Hibernate ignores a @Table on one, warning;
 *   JOINED -> each class has its own table for the columns it declares, joined
 *     to its parent's by the primary key (see `joinedKeys`);
 *   TABLE_PER_CLASS -> each class has its own table with every column,
 *     inherited ones too, which is how any entity is read without a hierarchy.
 *
 * A strategy written as anything else is not read: it is said, and the
 * subclass's table is graded HEURISTIC.
 */
function placeHierarchies(entities, entityRecords, resolveType, stats) {
  for (const e of entities.values()) e.parent = entityParentOf(e.fqn, entities, entityRecords, resolveType);
  for (const e of entities.values()) {
    if (!e.parent) continue;
    e.parent.subclasses.push(e.fqn);
    const root = rootOf(e);
    root.inheritance = root.record.inheritance ?? 'SINGLE_TABLE';
    e.inheritance = root.inheritance;
    if (e.inheritance === 'SINGLE_TABLE') {
      Object.assign(e, { table: root.table, tableGrade: root.tableGrade, tableEvidence: root.tableEvidence, sharesRootTable: true });
    } else if (!INHERITANCE_STRATEGIES.has(e.inheritance)) {
      e.tableGrade = 'HEURISTIC';
      note(stats, 'inheritance-strategy-unread', `${root.fqn} declares @Inheritance(strategy = ${e.inheritance}), which this lane does not read, so where ${e.fqn} keeps its rows is not known`);
    }
  }
}

/** The nearest @Entity a class extends, through any @MappedSuperclass; null for none, or one outside the pack. */
function entityParentOf(fqn, entities, entityRecords, resolveType) {
  const seen = new Set([fqn]);
  let cur = fqn;
  for (;;) {
    const rec = entityRecords.get(cur);
    const up = rec && rec.superclass ? resolveType(cur, rec.superclass) : null;
    if (!up || seen.has(up) || !entityRecords.has(up)) return null;
    if (entities.has(up)) return entities.get(up);
    seen.add(up);
    cur = up;
  }
}

/** The top entity of a hierarchy. */
function rootOf(e) {
  const seen = new Set();
  let r = e;
  while (r.parent && !seen.has(r.parent.fqn)) {
    seen.add(r.fqn);
    r = r.parent;
  }
  return r;
}

/**
 * Under JOINED, the entity whose table holds what each class of the chain
 * declares: an entity's own attributes are on its own table, and a
 * @MappedSuperclass's are on the table of the entity just below it.
 * @returns {Map<string, object>} class fqn -> entity
 */
function joinedHomes(e, entities, entityRecords, resolveType) {
  const homes = new Map();
  const seen = new Set();
  let owner = e;
  let cur = e.fqn;
  while (cur && entityRecords.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    if (entities.has(cur)) owner = entities.get(cur);
    homes.set(cur, owner);
    const rec = entityRecords.get(cur);
    cur = rec.superclass ? resolveType(cur, rec.superclass) : null;
  }
  return homes;
}

/**
 * A JOINED subclass's table carries the primary key that joins it to its
 * parent's: the column `@PrimaryKeyJoinColumn` names, or by default the parent
 * key's own columns, each as sure as its name is. A parent key that is an
 * assumed default (`placeKey`) stays one here.
 */
function joinedKeys(entities) {
  const keyOf = (x, depth = 0) => {
    if (x.inheritance !== 'JOINED' || !x.parent || depth > entities.size) return x.pkColumns;
    const declared = x.record.primaryKeyJoinColumn;
    const up = keyOf(x.parent, depth + 1);
    return declared && up.length === 1 ? [{ column: declared, grade: 'EXACT', ...(up[0].assumed ? { assumed: true } : {}) }] : up;
  };
  for (const e of entities.values()) {
    if (e.inheritance !== 'JOINED' || !e.parent) continue;
    e.joinedKey = keyOf(e).map((c) => ({ ...c, grade: weakest(e.tableGrade, c.grade) }));
  }
  for (const e of entities.values()) {
    if (!e.joinedKey) continue;
    Object.assign(e, { pkColumns: e.joinedKey, pkColumn: e.joinedKey[0].column, assumedKey: null });
    for (const c of e.joinedKey) e.inboundColumns.push({ column: c.column, grade: c.grade });
  }
}

/** The entities that extend this one, however far down. */
function descendantsOf(e, entities) {
  const out = [];
  const queue = [...e.subclasses];
  while (queue.length > 0) {
    const fqn = queue.shift();
    if (out.includes(fqn)) continue;
    out.push(fqn);
    queue.push(...(entities.get(fqn)?.subclasses ?? []));
  }
  return out.sort(cmp);
}

/**
 * A statement on an entity with subclasses is POLYMORPHIC: the row it reads or
 * writes may be a subclass's, with columns (and under JOINED or
 * TABLE_PER_CLASS, tables) of its own. Those are not followed, and said.
 */
function polymorphicNote(e, entities) {
  if (!e || e.subclasses.length === 0) return [];
  return [{
    reason: 'polymorphic-subclasses-not-read',
    detail: `${e.fqn} has subclass entities (${descendantsOf(e, entities).join(', ')}). A row this statement reads or writes may be one of theirs, and what they add (their own columns, and under ${e.inheritance} their own tables where it keeps them apart) is not followed`,
  }];
}

/** The tables one row of an entity spans: its own, and under JOINED each parent's. */
function rowTables(entity) {
  const out = [entity];
  let cur = entity;
  while (cur.inheritance === 'JOINED' && cur.parent && !out.includes(cur.parent)) {
    cur = cur.parent;
    out.push(cur);
  }
  return out;
}

/** Mark every table one row of an entity spans, each as sure as its own name. */
function markRow(map, entity, access, grade, evidence = null) {
  for (const t of rowTables(entity)) mark(map, t.table, access, weakest(grade, t.tableGrade), evidence);
}

/** The entity whose table holds an attribute: under JOINED an inherited one is the parent's. */
const homeOf = (entity, attr) => attr.home ?? entity;

/**
 * 2. THE ATTRIBUTES, through the @MappedSuperclass chain. A base class's fields
 * are the entity's fields, and the entity's own override wins.
 */
function attributesThroughSuperclasses(entities, entityRecords, ctx) {
  const { resolveType, strategy, derivedGrade, namingEvidence } = ctx;
// ---- 2. attributes, through the @MappedSuperclass chain -----------------
const attributesOf = (fqn, seen = new Set()) => {
  if (seen.has(fqn)) return []; // a cycle in the extends chain: stop, do not hang
  seen.add(fqn);
  const rec = entityRecords.get(fqn);
  if (!rec) return [];
  const superFqn = rec.superclass ? resolveType(fqn, rec.superclass) : null;
  const inherited = superFqn && entityRecords.has(superFqn) ? attributesOf(superFqn, seen) : [];
  const own = (Array.isArray(rec.attributes) ? rec.attributes : []).map((a) => ({ ...a, declaredBy: fqn }));
  // Base-most first, and a subclass attribute of the same name REPLACES the
  // inherited one (Java's own shadowing rule).
  const byName = new Map();
  for (const a of [...inherited, ...own]) byName.set(a.name, a);
  return [...byName.values()];
};

const said = new Set();
for (const e of entities.values()) {
  const attrs = attributesOf(e.fqn);
  const homes = e.inheritance === 'JOINED' && e.parent ? joinedHomes(e, entities, entityRecords, resolveType) : null;
  const entityUnread = entityMappingsUnread(e, ctx);
  e.attributes = new Map();
  for (const a of attrs) readAttribute(e, a, { strategy, derivedGrade, namingEvidence, homes, entityUnread, stats: ctx.stats, said });
  placeKey(e, { ...ctx, entityRecords });
}
joinedKeys(entities);
placeDiscriminators(entities, ctx);
}

/**
 * The class annotations of one entity that leave its columns unknown: the
 * mappings this lane does not read, and any name it does not know (design 1).
 * Both are said; a class mapping that changes only what a statement loads or
 * writes is said apart, and leaves the columns as read.
 */
function entityMappingsUnread(e, ctx) {
  const anns = ctx.classAnnotations?.get(e.fqn) ?? [];
  const unread = anns.filter((n) => UNREAD_ENTITY_MAPPINGS.includes(n)
    || (!KNOWN_ENTITY_ANNOTATIONS.has(n) && !REACH_ENTITY_MAPPINGS.includes(n)));
  if (unread.length > 0) {
    note(ctx.stats, 'jpa-mapping-unread', `${e.fqn} is mapped with @${unread.join(', @')}, which this lane does not read, so any of its columns may be named or placed otherwise`);
  }
  const reach = anns.filter((n) => REACH_ENTITY_MAPPINGS.includes(n));
  if (reach.length > 0) {
    note(ctx.stats, 'jpa-reach-unread', `${e.fqn} carries @${reach.join(', @')}, which this lane does not read, so what a statement on it loads or writes may differ from this pack`);
  }
  return unread;
}

/**
 * THE PRIMARY KEY'S COLUMNS, as the tree declares them: the one @Id, every @Id
 * an @IdClass key is made of, or the columns of the @EmbeddedId's embeddable.
 * Every foreign key, join table column and joined subclass key that points at
 * the entity is named after these, one column per key column (JPA 2.10.x).
 *
 * A KEY THE TREE DOES NOT DECLARE (an @Id in a superclass outside it, such as a
 * library's AbstractPersistable) is JPA's usual `id` by assumption, and nothing
 * more: every column that rests on it is HEURISTIC, and the root of the
 * hierarchy says so once (design 4). Its column is part of the row, as the
 * superclass's @Id would be.
 */
function placeKey(e, ctx) {
  const ids = [...e.attributes.values()].filter((a) => a.id === true);
  const embeddedId = ids.length === 1 && ids[0].embedded === true ? ids[0] : null;
  const columns = embeddedId
    ? embeddedKeyColumns(embeddedId, ctx)
    : ids.filter((a) => a.column).map((a) => ({ column: a.column, grade: a.grade }));
  if (embeddedId && columns.length > 0) embeddedId.columns = columns;
  if (columns.length > 0) {
    Object.assign(e, { pkColumns: columns, pkColumn: columns[0].column, assumedKey: null });
    return;
  }
  const assumed = [{ column: derivedName('id', ctx.strategy, 'HEURISTIC').name, grade: 'HEURISTIC', assumed: true }];
  Object.assign(e, { pkColumns: assumed, pkColumn: assumed[0].column, assumedKey: assumed });
  if (!e.parent) {
    note(ctx.stats, 'primary-key-assumed', `${e.fqn} declares no primary key this lane read (${embeddedId ? `the @EmbeddedId type ${embeddedId.typeSimple ?? '?'} is not read` : 'the @Id may be in a superclass outside the tree'}), so its key column is the assumed default \`${assumed[0].column}\`, and every foreign key, join table column and subclass key named after it is graded HEURISTIC`);
  }
}

/** The key columns an @EmbeddedId's embeddable maps, each as sure as its own name and the id attribute's reading. */
function embeddedKeyColumns(a, ctx) {
  const fqn = a.typeSimple ? ctx.resolveType(a.declaredBy, a.typeSimple) : null;
  const rec = fqn ? ctx.entityRecords.get(fqn) : null;
  if (!rec || rec.embeddable !== true) return [];
  const out = [];
  for (const k of rec.attributes ?? []) {
    if (k.transient === true || k.relation || k.embedded === true) continue;
    const m = mapAttribute(k, ctx);
    const guessed = a.mappingGuessed === true || unreadMappings(k).length > 0 || unknownMappings(k).length > 0;
    if (m.column) out.push({ column: m.column, grade: guessed ? 'HEURISTIC' : m.grade });
  }
  return out;
}

/**
 * THE DISCRIMINATOR OF A SINGLE_TABLE HIERARCHY. Every row of the root's table
 * says which class it is, in a column every insert writes and every query on a
 * subclass filters by. A column the root declares with @DiscriminatorColumn is
 * one whose name this lane does not read, so it is said; one it does not declare
 * is JPA's DTYPE by the naming strategy, an assumed default, drawn HEURISTIC and
 * said.
 */
function placeDiscriminators(entities, ctx) {
  for (const e of entities.values()) {
    if (e.parent || e.subclasses.length === 0) continue;
    if ((ctx.classAnnotations?.get(e.fqn) ?? []).includes('DiscriminatorColumn')) {
      note(ctx.stats, 'jpa-column-not-drawn', `${e.fqn} declares @DiscriminatorColumn, whose name this lane does not read, so the discriminator column every statement on its hierarchy reads or writes is not drawn`);
      continue;
    }
    if (e.inheritance !== 'SINGLE_TABLE') continue;
    const name = derivedName('DTYPE', ctx.strategy, 'HEURISTIC').name;
    e.discriminator = { column: name, grade: 'HEURISTIC' };
    note(ctx.stats, 'discriminator-assumed', `${e.fqn} keeps its subclasses in one table (SINGLE_TABLE) and declares no @DiscriminatorColumn, so the discriminator column is the assumed default \`${name}\` (JPA's DTYPE by the naming strategy), graded HEURISTIC`);
  }
}

/** The discriminator column one entity's row carries, when its hierarchy has one this lane drew. */
function discriminatorOf(entity) {
  const root = rootOf(entity);
  if (!root.discriminator || root.inheritance !== 'SINGLE_TABLE') return null;
  return { table: root.table, column: root.discriminator.column, grade: weakest(root.tableGrade, root.discriminator.grade) };
}

/** Every column an attribute owns on its table: one, or one per key column (a composite key, a foreign key toward one). */
const attrColumns = (a) => (Array.isArray(a.columns) ? a.columns : (a.column ? [{ column: a.column, grade: a.grade }] : []));

/** HEURISTIC when an entity's key is an assumed default, EXACT otherwise: what a join on that key rests on. */
const keyAssumedGrade = (x) => ((x.pkColumns ?? []).some((c) => c.assumed === true) ? 'HEURISTIC' : 'EXACT');

/** The column pairs a join is made on, as its evidence writes them: `a.x=b.y`, one per key column. */
function joinPairs(ta, left, tb, right) {
  const n = Math.max(left.length, right.length, 1);
  return Array.from({ length: n }, (_, i) => `${ta}.${left[i]?.column ?? '?'}=${tb}.${right[i]?.column ?? '?'}`);
}

/**
 * Mapping annotations this bridge does not read, and that name or place a
 * column otherwise than the simplest reading would: a composite key
 * (`@JoinColumns`), a formula, an override of an inherited or embedded column,
 * a secondary table. The grade rests on finding the right column, so an
 * attribute that carries one keeps its reading, graded HEURISTIC, and the pack
 * says so. `@MapsId` counts only without a `@JoinColumn`: with one, the column
 * is named outright.
 */
const UNREAD_ATTRIBUTE_MAPPINGS = Object.freeze(['JoinColumns', 'JoinFormula', 'Formula', 'JoinColumnOrFormula', 'JoinColumnsOrFormulas',
  'AttributeOverride', 'AttributeOverrides', 'AssociationOverride', 'AssociationOverrides']);
const UNREAD_ENTITY_MAPPINGS = Object.freeze(['SecondaryTable', 'SecondaryTables', 'AttributeOverride', 'AttributeOverrides', 'AssociationOverride', 'AssociationOverrides']);

/**
 * "IT CHANGES NOTHING ABOUT THE COLUMNS" IS SAID ONLY OF A NAME THIS BRIDGE
 * KNOWS (RM67 review 4, design 1). Every annotation on an attribute is one of:
 * read by this bridge; known to name and place no column (a constraint, a
 * serializer, documentation, a generator, auditing); a mapping that adds a
 * column of the row this lane does not draw; a mapping that changes what a
 * statement loads or writes rather than which column; or unread. An unread one
 * is said, and the column it sits on is a guess, because a name nobody listed
 * may be one that renames it. The lists hold simple names, as the worker records
 * them (javafacts/21).
 */
const KNOWN_ATTRIBUTE_ANNOTATIONS = new Set([
  // read here
  'Column', 'Id', 'EmbeddedId', 'Embedded', 'Transient', 'JoinColumn', 'JoinTable', 'ManyToOne', 'OneToMany',
  'OneToOne', 'ManyToMany', 'ElementCollection', 'MapsId', 'MapKey', 'OrderBy',
  // the value of the column, not its name or its place
  'Basic', 'Lob', 'Version', 'Enumerated', 'Temporal', 'Convert', 'Access', 'GeneratedValue', 'SequenceGenerator',
  'TableGenerator', 'GenericGenerator', 'MapKeyEnumerated', 'MapKeyTemporal', 'MapKeyClass', 'Type', 'JdbcTypeCode',
  'JdbcType', 'ColumnDefault', 'ColumnTransformer', 'CreationTimestamp', 'UpdateTimestamp', 'Generated', 'NaturalId',
  'Nationalized', 'Check', 'Comment', 'Cache', 'BatchSize', 'OptimisticLock', 'NotAudited', 'SortNatural', 'SortComparator',
  'CreatedDate', 'LastModifiedDate', 'CreatedBy', 'LastModifiedBy',
  // constraints, serializers, documentation, source generation
  'NotNull', 'NotBlank', 'NotEmpty', 'Size', 'Pattern', 'Email', 'Min', 'Max', 'DecimalMin', 'DecimalMax', 'Digits',
  'Positive', 'PositiveOrZero', 'Negative', 'NegativeOrZero', 'Past', 'PastOrPresent', 'Future', 'FutureOrPresent',
  'AssertTrue', 'AssertFalse', 'Null', 'Valid', 'Length', 'Range', 'URL',
  'JsonIgnore', 'JsonProperty', 'JsonFormat', 'JsonIgnoreProperties', 'JsonBackReference', 'JsonManagedReference',
  'JsonInclude', 'JsonSerialize', 'JsonDeserialize', 'JsonView', 'JsonAlias', 'JsonUnwrapped', 'JsonIdentityReference',
  'JsonRawValue', 'JsonPropertyDescription', 'JSONField', 'Expose', 'SerializedName', 'DateTimeFormat', 'NumberFormat',
  'ApiModelProperty', 'Schema', 'Hidden', 'Deprecated', 'Override', 'SuppressWarnings',
  'Getter', 'Setter', 'Exclude', 'Include', 'Default', 'NonNull', 'Singular', 'With',
]);
/** Mappings that add a column of the row this lane does not draw: an order column, a map key, the columns of an @Any. */
const UNDRAWN_COLUMN_MAPPINGS = Object.freeze(['OrderColumn', 'IndexColumn', 'MapKeyColumn', 'MapKeyJoinColumn', 'MapKeyJoinColumns',
  'CollectionId', 'Any', 'ManyToAny']);
/** Mappings that change what a statement loads or writes through an attribute, not which column: a fetch mode, a filter, SQL written by hand. */
const REACH_ATTRIBUTE_MAPPINGS = Object.freeze(['Fetch', 'LazyCollection', 'LazyToOne', 'LazyGroup', 'Cascade', 'OnDelete', 'Where',
  'SQLRestriction', 'WhereJoinTable', 'SQLJoinTableRestriction', 'Filter', 'Filters', 'FilterJoinTable', 'FilterJoinTables',
  'NotFound', 'Loader', 'SQLInsert', 'SQLUpdate', 'SQLDelete', 'SQLDeleteAll', 'Persister', 'Audited']);

/** The same judgment for the annotations on an entity's own class. */
const KNOWN_ENTITY_ANNOTATIONS = new Set([
  'Entity', 'Table', 'Inheritance', 'PrimaryKeyJoinColumn', 'NamedEntityGraph', 'NamedEntityGraphs', 'IdClass',
  'DiscriminatorColumn', 'DiscriminatorValue', 'Access', 'EntityListeners', 'Cacheable', 'Cache', 'TableGenerator',
  'TableGenerators', 'SequenceGenerator', 'SequenceGenerators', 'GenericGenerator', 'Immutable', 'DynamicInsert',
  'DynamicUpdate', 'SelectBeforeUpdate', 'BatchSize', 'Proxy', 'OptimisticLocking', 'Check', 'Comment', 'Indexed',
  'Getter', 'Setter', 'Data', 'Builder', 'SuperBuilder', 'NoArgsConstructor', 'AllArgsConstructor', 'RequiredArgsConstructor',
  'EqualsAndHashCode', 'ToString', 'Accessors', 'Value', 'FieldNameConstants', 'With', 'Slf4j', 'Log4j2',
  'JsonIgnoreProperties', 'JsonInclude', 'JsonNaming', 'JsonTypeInfo', 'JsonSubTypes', 'JsonAutoDetect', 'JsonPropertyOrder',
  'JsonFilter', 'JsonIdentityInfo', 'JsonRootName', 'JsonSerialize', 'JsonDeserialize', 'ApiModel', 'Schema',
  'Deprecated', 'SuppressWarnings',
]);
/** Class mappings that change what a statement on the entity loads or writes: a filter, a named query, SQL written by hand, an audit table. */
const REACH_ENTITY_MAPPINGS = Object.freeze(['Where', 'SQLRestriction', 'Filter', 'Filters', 'FilterDef', 'FilterDefs', 'Loader',
  'SQLInsert', 'SQLUpdate', 'SQLDelete', 'SQLDeleteAll', 'NamedQuery', 'NamedQueries', 'NamedNativeQuery', 'NamedNativeQueries',
  'SqlResultSetMapping', 'SqlResultSetMappings', 'Subselect', 'Synchronize', 'Audited', 'DiscriminatorFormula', 'SoftDelete',
  'Persister', 'Polymorphism']);

/** The annotations on one attribute that this bridge does not read (javafacts/21 records them all). */
function unreadMappings(a) {
  const names = Array.isArray(a.annotations) ? a.annotations : [];
  const out = names.filter((n) => UNREAD_ATTRIBUTE_MAPPINGS.includes(n));
  if (names.includes('MapsId') && !a.joinColumn) out.push('MapsId');
  return out;
}

/** The annotations on one attribute that no list above names: unknown, so not known to leave the column alone. */
function unknownMappings(a) {
  const names = Array.isArray(a.annotations) ? a.annotations : [];
  return names.filter((n) => !KNOWN_ATTRIBUTE_ANNOTATIONS.has(n) && !UNREAD_ATTRIBUTE_MAPPINGS.includes(n)
    && !UNDRAWN_COLUMN_MAPPINGS.includes(n) && !REACH_ATTRIBUTE_MAPPINGS.includes(n));
}

/** One attribute of one entity: its column, the table that holds it, and what this lane did not read about it. */
function readAttribute(e, a, ctx) {
  const { homes, entityUnread, stats } = ctx;
  const unread = unreadMappings(a);
  const unknown = unknownMappings(a);
  const read = mapAttribute(a, ctx);
  const guessed = unread.length > 0 || unknown.length > 0 || entityUnread.length > 0;
  const mapped = guessed ? { ...read, grade: 'HEURISTIC', mappingGuessed: true } : read;
  const home = homes ? homes.get(a.declaredBy) : null;
  e.attributes.set(a.name, { ...a, ...mapped, ...(home && home !== e ? { home } : {}) });
  if (a.elementCollection === true) {
    note(stats, 'element-collection-not-read', `${e.fqn}.${a.name} is an @ElementCollection: its values live in a table of their own, which this lane does not read, so no statement here reaches it`);
  }
  if (unread.length > 0) {
    note(stats, 'jpa-mapping-unread', `${e.fqn}.${a.name} is mapped with @${unread.join(', @')}, which this lane does not read, so the column it names is a guess`);
  }
  sayAttribute(stats, a, unknown, ctx.said);
}

/**
 * What one attribute's mapping leaves out of the pack, said once for the class
 * that declares it (a mapped superclass's field is every entity's): a name this
 * lane does not know, a column it adds that is not drawn, a map keyed by a
 * column JPA names by default, an embedded value, and what a statement loads or
 * writes otherwise through it.
 */
function sayAttribute(stats, a, unknown, said) {
  const names = Array.isArray(a.annotations) ? a.annotations : [];
  const who = `${a.declaredBy}.${a.name}`;
  const once = (reason, detail) => {
    if (said.has(`${reason}|${who}`)) return;
    said.add(`${reason}|${who}`);
    note(stats, reason, detail);
  };
  if (unknown.length > 0) {
    once('jpa-annotation-unknown', `${who} carries @${unknown.join(', @')}, which this lane does not know, so whether it names or places the column otherwise is not known and the column it maps is a guess`);
  }
  const undrawn = names.filter((n) => UNDRAWN_COLUMN_MAPPINGS.includes(n));
  const toMany = a.relation === 'oneToMany' || a.relation === 'manyToMany';
  if (toMany && a.typeSimple === 'Map' && !names.some((n) => n === 'MapKey' || n.startsWith('MapKeyColumn') || n.startsWith('MapKeyJoinColumn'))) undrawn.push('(a Map keyed by the column JPA names by default)');
  if (undrawn.length > 0) {
    once('jpa-column-not-drawn', `${who} is mapped with ${undrawn.map((n) => (n.startsWith('(') ? n : `@${n}`)).join(', ')}, which adds a column of the row that this lane does not draw, so a statement that reads or writes this association touches a column this pack does not name`);
  }
  if (a.embedded === true && a.id !== true) {
    once('embedded-not-read', `${who} is @Embedded: the columns of its embeddable live on this table and this lane does not draw them, so a statement that reads or writes the row touches columns this pack does not name`);
  }
  const reach = names.filter((n) => REACH_ATTRIBUTE_MAPPINGS.includes(n));
  if (reach.length > 0) {
    once('jpa-reach-unread', `${who} carries @${reach.join(', @')}, which this lane does not read, so what a statement loads or writes through it may differ from this pack`);
  }
}

/**
 * 3. THE TABLE AND COLUMN NODES, and the JOINS an association carries. THE
 * CATALOG'S OWN SPELLING WINS: the SQL bridge keyed every table and column by
 * what the DDL wrote, and two spellings of one table are two nodes.
 */
function tableColumnAndJoinNodes(g, entities, ctx) {
  const { opts, schema, resolveType, strategy, derivedGrade, stats } = ctx;
// ---- 3. table / column nodes + JOINS ------------------------------------
//
// THE CATALOG'S OWN SPELLING WINS. The SQL bridge keyed every table and column
// node by what the DDL wrote; the naming strategy here derives `id` where an
// Oracle / HSQLDB / H2 DDL says `ID`. Matched through the SAME fold the SQL
// lane used, the derived name lands on the catalog's node; matched by string,
// it would create a second node for one column and split every answer about it
// in half — exactly the defect the MyBatis-Plus lane had against jeecg-boot's
// `sys_user_depart.ID`. petclinic's DDL is lower case and its rule is
// fold-lower, so nothing there moves; an upper-case DDL is where it shows.
// The fold lives in ONE helper, shared with mp_bridge (sql_bridge.mjs).
const { settle, register } = graphSpellingIndex(g, opts.identifierCase ?? 'exact');
const tableIdOf = (name) => settle(nodeId('table', tableKey(schema, name)));
const columnIdOf = (table, column) => settle(nodeId('column', columnKey(schema, table, column)));

const ensureTable = (name, evidence) => {
  const id = tableIdOf(name);
  if (!g.nodes.has(id)) {
    // Not in the catalog (no DDL, or a table only JPA knows about). Created as
    // a STUB so the reader can tell "declared by the mapping" from "read from
    // the schema" — never presented as a catalog fact.
    g.addNode({ id, stub: true, declaredBy: 'jpa', ...evidence });
    stats.tablesStubbed += 1;
  }
  return id;
};
const ensureColumn = (table, column, grade) => {
  const tid = tableIdOf(table);
  const cid = columnIdOf(table, column);
  if (!g.nodes.has(cid)) {
    g.addNode({ id: cid, name: column, stub: true, declaredBy: 'jpa' });
    g.addEdge({ from: tid, to: cid, type: 'DECLARES', grade });
    stats.columnsStubbed += 1;
    // A stub the derived name INVENTED still has to be findable by the fold,
    // or the next entity that derives the same name would make a third node.
    register(cid);
  }
  return cid;
};

for (const e of entities.values()) {
  ensureTable(e.table, { mappedFrom: e.fqn });
  const tnode = g.nodes.get(tableIdOf(e.table));
  // A single-table subclass lands on its root's table, which stays the root's.
  if (tnode && e.sharesRootTable !== true) {
    tnode.jpaEntity = e.fqn;
    tnode.jpaMappingGrade = e.tableGrade;
  }
  if (e.sharesRootTable !== true) stats.tables += 1;
  for (const a of e.attributes.values()) {
    const home = homeOf(e, a);
    for (const c of attrColumns(a)) {
      ensureColumn(home.table, c.column, weakest(home.tableGrade, c.grade));
      stats.columns += 1;
    }
  }
  // A key or a discriminator the mapping does not declare is still a column of
  // the row, as sure as the default it was named by.
  for (const c of e.assumedKey ?? []) ensureColumn(e.table, c.column, weakest(e.tableGrade, c.grade));
  if (e.discriminator) ensureColumn(e.table, e.discriminator.column, weakest(e.tableGrade, e.discriminator.grade));
}

// Associations -> the physical column that carries them, plus a JOINS edge.
// The pairs already in the graph (the SQL lane's joins) are indexed once, so
// adding N associations does not cost N scans of the edge list.
const joinSeen = new Set();
for (const edge of g.edges) if (edge.type === 'JOINS') joinSeen.add(`${edge.from}|${edge.to}`);
const writers = { tableIdOf, ensureTable, ensureColumn, joinSeen };
for (const e of entities.values()) {
  if (e.joinedKey) {
    for (const c of e.joinedKey) ensureColumn(e.table, c.column, c.grade);
    addJoin(g, joinSeen, tableIdOf(e.table), tableIdOf(e.parent.table), joinPairs(e.table, e.joinedKey, e.parent.table, e.parent.pkColumns),
      weakest(e.parent.tableGrade, keyAssumedGrade(e.parent), ...e.joinedKey.map((c) => c.grade)), stats);
  }
  for (const a of e.attributes.values()) {
    if (!a.relation || a.transient === true) continue;
    const target = a.targetSimple ? entities.get(resolveType(e.fqn, a.targetSimple) ?? '') : null;
    if (!target) {
      note(stats, 'association-target-unknown', `${e.fqn}.${a.name}: ${a.targetSimple ?? '?'} is not an @Entity this pack saw`);
      continue;
    }
    linkAssociation(g, homeOf(e, a), a, target, { strategy, derivedGrade, stats, ...writers });
  }
}

// I-1, spelled out: a catalog HIT is evidence, never a promotion.
for (const e of entities.values()) {
  const tnode = g.nodes.get(tableIdOf(e.table));
  if (tnode && tnode.stub !== true) tnode.jpaCatalogMatch = true;
}

  return { tableIdOf, columnIdOf, ensureTable, ensureColumn };
}

/**
 * Whether an association crosses a JOIN TABLE: a @ManyToMany, anything that
 * writes @JoinTable, and a unidirectional @OneToMany with no @JoinColumn, which
 * JPA maps through a join table too. The inverse side (`mappedBy`) crosses the
 * owning side's, if any.
 */
const usesJoinTable = (a) => !a.mappedBy && (a.relation === 'manyToMany' || !!a.joinTable || (a.relation === 'oneToMany' && !a.joinColumn));

/**
 * One association's physical side: the foreign key it owns, the one it puts on
 * the target, or the join table it crosses, with the JOINS edges between them.
 * `e` is the entity whose table holds the attribute.
 */
function linkAssociation(g, e, a, target, ctx) {
  const { strategy, stats, tableIdOf, ensureColumn, joinSeen } = ctx;
  const pairGrade = weakest(e.tableGrade, target.tableGrade, a.grade);
  if (usesJoinTable(a)) {
    linkJoinTable(g, e, a, target, ctx);
  } else if (a.relation === 'manyToOne' || a.relation === 'oneToOne') {
    if (a.mappedBy) return; // the OTHER side owns the column
    const { cols, colGrade } = ownedForeignKey(a, target, { strategy, pairGrade });
    for (const c of cols) ensureColumn(e.table, c.column, c.grade);
    // The join names the target's key: an assumed one makes the join a guess too.
    addJoin(g, joinSeen, tableIdOf(e.table), tableIdOf(target.table), joinPairs(e.table, cols, target.table, target.pkColumns),
      weakest(colGrade, keyAssumedGrade(target)), stats);
  } else if (a.relation === 'oneToMany') {
    // A unidirectional @OneToMany with a @JoinColumn puts the foreign key on
    // the TARGET table (that is what `pets.owner_id` is); with `mappedBy` the
    // other side already declared it. Either way this table gains no column.
    const col = a.mappedBy ? null : a.joinColumn;
    if (col) {
      ensureColumn(target.table, col, pairGrade);
      if (!target.inboundColumns.some((c) => c.column === col)) target.inboundColumns.push({ column: col, grade: pairGrade });
    }
    addJoin(g, joinSeen, tableIdOf(e.table), tableIdOf(target.table),
      col ? joinPairs(e.table, e.pkColumns, target.table, [{ column: col }]) : `${e.table}~${target.table}`,
      col ? weakest(pairGrade, keyAssumedGrade(e)) : pairGrade, stats);
  }
}

/** The join table one owning association crosses, its columns, and the two JOINS edges to it. */
function linkJoinTable(g, e, a, target, ctx) {
  const { strategy, derivedGrade, stats, tableIdOf, ensureTable, ensureColumn, joinSeen } = ctx;
  const jt = joinTableOf(e, a, target, { strategy, derivedGrade });
  // Kept on the attribute so a statement that FOLLOWS this association later
  // reaches the same three names, graded the same way, instead of a second
  // reading of the mapping that could differ from this one.
  a.joinTableResolved = jt;
  ensureTable(jt.table, { joinTableFor: [e.fqn, target.fqn] });
  for (const c of jt.columns) ensureColumn(c.table, c.column, c.grade);
  addJoin(g, joinSeen, tableIdOf(e.table), tableIdOf(jt.table), joinPairs(e.table, e.pkColumns, jt.table, jt.left),
    weakest(keyAssumedGrade(e), ...jt.left.map((c) => c.grade)), stats);
  addJoin(g, joinSeen, tableIdOf(target.table), tableIdOf(jt.table), joinPairs(target.table, target.pkColumns, jt.table, jt.right),
    weakest(keyAssumedGrade(target), ...jt.right.map((c) => c.grade)), stats);
}

/**
 * The foreign key a @ManyToOne / @OneToOne owns on its own table: the column it
 * declares, or `<attribute>_<key column>` by the strategy, one per column of the
 * target's key (JPA 2.10.x: a composite key is referenced by every one of its
 * columns, and `owner_id` is a column no such table has). Each derived name is
 * as sure as the key column it is named after. The resolved names and grade are
 * recorded back on the attribute, so the columns are part of the row every
 * statement reads and writes.
 */
function ownedForeignKey(a, target, { strategy, pairGrade }) {
  if (a.column) return { cols: [{ column: a.column, grade: pairGrade }], colGrade: pairGrade };
  const own = a.grade;
  const cols = [];
  const attrCols = [];
  for (const k of target.pkColumns) {
    const fk = derivedName(`${a.name}_${k.column}`, strategy, pairGrade);
    // The name's own doubt: a spelling the Hibernate version decides, or a key it is named after that is a guess.
    const nameGrade = weakest(fk.grade === pairGrade ? 'EXACT' : fk.grade, k.grade);
    cols.push({ column: fk.name, grade: weakest(pairGrade, fk.grade, k.grade) });
    attrCols.push({ column: fk.name, grade: own ? weakest(own, nameGrade) : weakest(pairGrade, nameGrade) });
  }
  a.column = cols[0].column;
  a.grade = weakest(...attrCols.map((c) => c.grade));
  if (cols.length > 1) a.columns = attrCols;
  return { cols, colGrade: weakest(...cols.map((c) => c.grade)) };
}

/**
 * The physical JOIN TABLE an association crosses, and how sure each of its three
 * names is. The table name, the owning column and the inverse column are three
 * separate declarations, and any one of them may be left to the naming strategy,
 * so each is graded on its own evidence.
 *
 * THE DEFAULTS. Spring Boot's SpringImplicitNamingStrategy names the table after
 * the owning table's physical name and the attribute (`owners` + `_` +
 * `specialTags`, then the physical strategy: `owners_special_tags`); every
 * strategy the profile can declare is Spring Boot's. The two columns are JPA's
 * (2.10.4, 2.10.5): the owning side's is the inverse attribute's name, or the
 * owning entity's name when nothing maps the association back, then `_` and its
 * key; the other side's is the attribute's name, `_`, the target's key.
 */
function joinTableOf(e, a, target, { strategy, derivedGrade }) {
  const jt = a.joinTable;
  const named = !!(jt && jt.name);
  const derivedTable = derivedName(`${e.table}_${a.name}`, strategy, derivedGrade);
  const table = named ? jt.name : derivedTable.name;
  const nameGrade = named ? 'EXACT' : weakest(e.tableGrade, derivedTable.grade);
  const inverse = [...(target.attributes?.values() ?? [])].find((t) => t.mappedBy === a.name);
  // One column per key column on each side, each named after its key column and as sure as it.
  const side = (declaredName, logical, k) => {
    if (declaredName) return { name: declaredName, grade: 'EXACT' };
    const d = derivedName(logical, strategy, derivedGrade);
    return { name: d.name, grade: weakest(d.grade, k.grade) };
  };
  const left = e.pkColumns.map((k, i) => side(jt?.joinColumns?.[i], `${inverse ? inverse.name : e.entityName}_${k.column}`, k))
    .map((c) => ({ table, column: c.name, grade: weakest(e.tableGrade, nameGrade, c.grade) }));
  const right = target.pkColumns.map((k, i) => side(jt?.inverseJoinColumns?.[i], `${a.name}_${k.column}`, k))
    .map((c) => ({ table, column: c.name, grade: weakest(target.tableGrade, nameGrade, c.grade) }));
  return {
    table,
    grade: weakest(e.tableGrade, target.tableGrade, nameGrade),
    columns: [...left, ...right],
    left,
    right,
  };
}

/** 4. REPOSITORIES -> STATEMENTS: what each declared method runs. */
function repositoryStatements(g, entities, repositories, ctx) {
  const { resolveType, stats } = ctx;
// ---- 4. repositories -> statements --------------------------------------
const repoByFqn = new Map();
for (const rec of repositories) {
  stats.repositories += 1;
  const entityFqn = rec.entityTypeSimple ? resolveType(rec.fqn, rec.entityTypeSimple) : null;
  const entity = entityFqn ? entities.get(entityFqn) : null;
  const declaredMethods = new Set((rec.methods ?? []).map((m) => m.name));
  repoByFqn.set(rec.fqn, { rec, entity, declaredMethods });
  if (!entity) {
    note(stats, 'repository-entity-unknown',
      `${rec.fqn}: the domain type ${rec.entityTypeSimple ?? '?'} is not an @Entity this pack saw, so its queries touch no table`);
    continue;
  }
  // An OVERLOAD names one statement: Spring Data derives the same query from
  // `findAll()` and `findAll(Pageable)`. Emitting it twice would double-count
  // the statement and add a second IMPLEMENTS_STMT edge to the same node.
  const emittedHere = new Set();
  for (const m of rec.methods ?? []) {
    if (emittedHere.has(m.name)) continue;
    emittedHere.add(m.name);
    addQueryStatement(g, { ...ctx, repo: rec, method: m, entity, entities });
  }
}

  return repoByFqn;
}

/**
 * 5. THE BUILT-INS A SERVICE CALLS AND THE REPOSITORY NEVER DECLARED. `save`,
 * `findById` and their kin are Spring Data's, not the interface's, so nothing
 * declares them and a caller still runs them.
 */
function builtinStatements(g, entities, repoByFqn, calls, ctx) {
  const { resolveType, stats } = ctx;
// ---- 5. built-ins the service calls but the repository never declared ----
const wanted = new Map(); // "repoFqn#method" -> {repoFqn, method}
for (const c of calls) {
  if (!c || !c.from || !c.method) continue;
  if (!Object.hasOwn(BUILTIN_METHODS, c.method)) continue;
  const ownerFqn = c.from.slice(0, c.from.lastIndexOf('#'));
  const targetFqn = resolveType(ownerFqn, c.toTypeSimple);
  if (!targetFqn || !repoByFqn.has(targetFqn)) continue;
  const r = repoByFqn.get(targetFqn);
  if (r.declaredMethods.has(c.method)) continue; // declared: it is a derived/@Query statement
  wanted.set(`${targetFqn}#${c.method}`, { repoFqn: targetFqn, method: c.method });
}
for (const { repoFqn, method } of [...wanted.values()].sort((a, b) => cmp(`${a.repoFqn}#${a.method}`, `${b.repoFqn}#${b.method}`))) {
  const r = repoByFqn.get(repoFqn);
  if (!r.entity) continue;
  addBuiltinStatement(g, { ...ctx, repoFqn, method, entity: r.entity, file: r.rec.file ?? null, entities });
  stats.builtins += 1;
}

stats.unresolvedStatements = new Set(stats.unresolved.filter((u) => u.statement).map((u) => u.statement)).size;
}


export function addJpaFacts(g, javaFacts, opts = {}) {
  if (!g || !g.nodes || !Array.isArray(g.edges)) throw new JpaBridgeError('g must be a Graph');
  if (!Array.isArray(javaFacts)) throw new JpaBridgeError('javaFacts must be an array');

  const declared = opts.namingStrategy != null;
  const strategy = declared ? opts.namingStrategy : ASSUMED_NAMING_STRATEGY;
  if (!NAMING_STRATEGIES.includes(strategy)) {
    throw new JpaBridgeError(`unknown jpa.namingStrategy ${JSON.stringify(opts.namingStrategy)}. Expected one of ${NAMING_STRATEGIES.join(', ')}`);
  }
  // A name the ENGINE derived is HEURISTIC unless the project declared the rule
  // it was derived by. A name the SOURCE wrote down is EXACT either way.
  const derivedGrade = declared ? 'EXACT' : 'HEURISTIC';
  const namingEvidence = declared ? 'declared' : 'assumed-spring-default';
  const schema = opts.schema ?? null;

  const { resolveType } = buildTypeIndex(javaFacts);
  const entityRecords = new Map();   // fqn -> record
  const classAnnotations = new Map(); // fqn -> the annotations its class carries
  const repositories = [];
  const calls = [];
  for (const r of javaFacts) {
    if (!r || typeof r !== 'object') continue;
    if (r.kind === 'entity') entityRecords.set(r.fqn, r);
    else if (r.kind === 'repository') repositories.push(r);
    else if (r.kind === 'call') calls.push(r);
    else if (r.kind === 'type' && Array.isArray(r.annotations)) classAnnotations.set(r.fqn, r.annotations);
  }

  const stats = {
    entities: 0, mappedSuperclasses: 0, repositories: 0,
    tables: 0, tablesStubbed: 0, columns: 0, columnsStubbed: 0, joins: 0,
    statements: 0, statementsByType: { derived: 0, jpql: 0, native: 0, builtin: 0 },
    implementsStmt: 0, unresolvedStatements: 0, unresolved: [],
    builtins: 0, namingStrategy: strategy, namingStrategyDeclared: declared,
    // Associations a statement's fetch plan reached and did NOT follow, because
    // they are LAZY. Each one is a read that happens when something asks for it
    // later, which is a moment this lane cannot see (see `applyFetchPlan`).
    lazyAssociationsNotFollowed: 0,
  };
  if (entityRecords.size === 0 && repositories.length === 0) return stats;

  const naming = { strategy, derivedGrade, namingEvidence, stats };
  const entities = entityTables(entityRecords, { ...naming, resolveType });
  attributesThroughSuperclasses(entities, entityRecords, { resolveType, classAnnotations, ...naming });
  const nodes = tableColumnAndJoinNodes(g, entities, {
    opts, schema, resolveType, strategy, derivedGrade, stats,
  });
  // What a STATEMENT needs to follow a fetch plan: the entity model, the naming
  // rules the join tables are derived by, the two node writers, and the named
  // fetch plans the entities declare.
  const stmtCtx = {
    ...nodes, resolveType, stats, strategy, derivedGrade,
    namedGraphs: namedEntityGraphs(entityRecords),
  };
  const repoByFqn = repositoryStatements(g, entities, repositories, stmtCtx);
  builtinStatements(g, entities, repoByFqn, calls, stmtCtx);

  return stats;
}

/**
 * Every `@NamedEntityGraph` the entities declare, by name. The plan is declared
 * on the ENTITY and named by a repository method in another file, so this is the
 * one place that holds both halves.
 */
function namedEntityGraphs(entityRecords) {
  const out = new Map();
  for (const rec of entityRecords.values()) {
    for (const g of rec.namedEntityGraphs ?? []) {
      if (!g || typeof g.name !== 'string' || g.name.length === 0) continue;
      if (out.has(g.name)) continue; // first declaration wins, as the stream is sorted
      out.set(g.name, (Array.isArray(g.attributePaths) ? g.attributePaths : []).filter((p) => typeof p === 'string' && p.length > 0));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// attributes
// ---------------------------------------------------------------------------

/**
 * The physical column one attribute maps to, and how sure that is.
 * `column: null` means "this attribute owns no column on this table" — a
 * @Transient field, a collection, or the inverse side of an association.
 */
function mapAttribute(a, { strategy, derivedGrade, namingEvidence }) {
  // `targetEntity = Pet.class` is the mapping saying the other side outright, so
  // it wins over the field's own type — which for a raw `List pets` says nothing.
  // A to-many's other side is its ELEMENT type, the last type argument: a
  // `List<Pet>` and a `Map<PetType, Pet>` both hold pets (javafacts/21).
  const args = Array.isArray(a.typeArgSimples) ? a.typeArgSimples : [];
  const toMany = a.relation === 'oneToMany' || a.relation === 'manyToMany';
  const elementType = toMany && args.length > 0 ? args[args.length - 1] : a.typeArgSimple;
  const targetSimple = a.targetEntity ?? elementType ?? a.typeSimple ?? null;
  const explicitColumn = typeof a.column === 'string' && a.column.length > 0;
  const explicitJoin = typeof a.joinColumn === 'string' && a.joinColumn.length > 0;
  // A @JoinTable(name=…, joinColumns=@JoinColumn(name=…)) declares the physical
  // names just as explicitly as a @JoinColumn does — the strategy is not
  // consulted, so the mapping is EXACT whether or not the profile declares one.
  const explicitJoinTable = !!(a.joinTable && a.joinTable.name);
  const base = {
    targetSimple,
    joinColumn: explicitJoin ? a.joinColumn : null,
    joinTable: a.joinTable ?? null,
    evidence: explicitColumn || explicitJoin || explicitJoinTable ? 'declared' : namingEvidence,
  };
  if (a.transient === true) return { ...base, column: null, grade: 'EXACT', reason: '@Transient' };
  if (a.embedded === true) return { ...base, column: null, grade: derivedGrade, reason: '@Embedded is not modelled' };
  if (a.elementCollection === true) return { ...base, column: null, grade: 'HEURISTIC', reason: '@ElementCollection keeps its values in a table this lane does not read' };
  if (a.relation === 'oneToMany' || a.relation === 'manyToMany') {
    // The inverse side names no column and no join table of its own: the side
    // it is mapped by owns them, and grades them there. Nothing is derived here.
    if (a.mappedBy) return { ...base, column: null, grade: 'EXACT', reason: 'mappedBy: the other side owns the column' };
    return { ...base, column: null, grade: explicitJoin || explicitJoinTable ? 'EXACT' : derivedGrade };
  }
  if (a.relation === 'manyToOne' || a.relation === 'oneToOne') {
    if (a.mappedBy) return { ...base, column: null, grade: 'EXACT', reason: 'mappedBy: the other side owns the column' };
    return { ...base, column: explicitJoin ? a.joinColumn : null, grade: explicitJoin ? 'EXACT' : derivedGrade };
  }
  const derived = derivedName(a.name, strategy, derivedGrade);
  return {
    ...base,
    column: explicitColumn ? a.column : derived.name,
    grade: explicitColumn ? 'EXACT' : derived.grade,
  };
}

// ---------------------------------------------------------------------------
// statements
// ---------------------------------------------------------------------------

function addQueryStatement(g, ctx) {
  const { repo, method, stats } = ctx;
  const key = statementKey(repo.fqn, method.name);
  const sid = nodeId('statement', key);
  const q = method.query;
  const type = q ? (q.native ? 'native' : 'jpql') : 'derived';

  // {table, column, grade, evidence} in `reads`/`writes`; table -> {access, grade}
  const sink = { reads: [], writes: [], tableAccess: new Map(), unresolved: [] };
  const query = readQueryRefs(type, q, ctx, sink);
  // …and everything the query does NOT name and still loads: the eager closure,
  // plus the paths the query's own plan forces (JOIN FETCH, @EntityGraph).
  const forced = [...query.forced, ...entityGraphPaths(ctx, sink)];
  const limits = query.root ? applyFetchPlan(query.root, ctx, forced, sink) : [];
  sink.unresolved.push(...polymorphicNote(query.root, ctx.entities));

  emitStatement(g, {
    sid, key, type, file: repo.file ?? null, line: method.line ?? null,
    member: `${repo.fqn}#${method.name}`, ...sink, stats,
    tableIdOf: ctx.tableIdOf, columnIdOf: ctx.columnIdOf,
    evidence: {
      repository: repo.fqn, method: method.name, base: repo.base,
      ...(limits.length > 0 ? { limits } : {}),
    },
  });
}

/**
 * WHAT THE QUERY ITSELF SAYS: the columns it names, the entity its result IS,
 * and the paths its own text forces to be loaded. A native query is the SQL
 * lane's — `analyze` feeds its text to lineage.py alongside the mapper
 * statements — so nothing is read here beyond declaring the node.
 * @returns {{root:(object|null), forced:{path:string, rule:string}[]}}
 */
function readQueryRefs(type, q, ctx, sink) {
  const none = { root: null, forced: [] };
  if (type === 'native') {
    if (!q.text) sink.unresolved.push({ reason: 'empty-native-query', detail: '@Query(nativeQuery=true) carries no SQL' });
    return none;
  }
  if (type === 'jpql') {
    const read = readJpql(q.text ?? '');
    for (const d of read.diagnostics) sink.unresolved.push(d);
    if (!read.ok) {
      sink.unresolved.push({ reason: 'jpql-unreadable', detail: String(q.text ?? '').slice(0, 200) });
      return none;
    }
    const refs = resolveJpqlRefs(read, ctx, sink);
    // A FROM on a SINGLE_TABLE subclass is filtered by the hierarchy's discriminator.
    for (const root of read.roots) {
      const target = jpqlEntityOf(root.entity, ctx);
      const d = target && target.parent ? discriminatorOf(target) : null;
      if (d) sink.reads.push(d);
    }
    return refs;
  }
  const parsed = parseDerivedQuery(ctx.method.name);
  if (!parsed.ok) {
    sink.unresolved.push({ reason: 'derived-name-unreadable', detail: parsed.reason });
    return none;
  }
  return resolveDerivedRefs(parsed, ctx, sink);
}

/**
 * The attribute paths a method's `@EntityGraph` asks for. Written out
 * (`attributePaths = {"pets"}`) they are read as they stand; named
 * (`@EntityGraph("Owner.pets")`) they are resolved against the
 * `@NamedEntityGraph` the entity declares, and a name no entity in this pack
 * declares is REPORTED rather than quietly followed or quietly dropped.
 */
function entityGraphPaths(ctx, sink) {
  const eg = ctx.method && ctx.method.entityGraph;
  if (!eg || typeof eg !== 'object') return [];
  const written = Array.isArray(eg.attributePaths) ? eg.attributePaths.filter((p) => typeof p === 'string' && p.length > 0) : [];
  if (written.length > 0) return written.map((path) => ({ path, rule: 'jpa-entity-graph' }));
  if (typeof eg.name !== 'string' || eg.name.length === 0) return [];
  const named = (ctx.namedGraphs ?? new Map()).get(eg.name);
  if (!named) {
    sink.unresolved.push({
      reason: 'entity-graph-unresolved',
      detail: `@EntityGraph("${eg.name}") names no @NamedEntityGraph this pack saw, so the paths it would have loaded are not followed`,
    });
    return [];
  }
  return named.map((path) => ({ path, rule: 'jpa-entity-graph' }));
}

/** A derived query's predicate/order columns, resolved through the entity model. */
function resolveDerivedRefs(parsed, ctx, sink) {
  const { entity, entities, resolveType } = ctx;
  const access = parsed.access; // 'select' | 'delete'
  const lookup = makeLookup(entities, resolveType);

  const touched = [];
  // Each table's own grade, the one its access is marked with: a column whose
  // name is derived is a guess on its own READS edge, not on the table.
  const tableGrades = new Map(rowTables(entity).map((t) => [t.table, t.tableGrade]));
  const props = [...parsed.parts.map((p) => p.property), ...parsed.orderBy.map((o) => o.property)];
  if (props.length === 0 && access === 'select') {
    // `findAll`, `findAllByOrderBy…` with no predicate: the query reads the whole
    // row. Not a guess — that is what "no predicate" means.
    for (const c of columnsOf(entity)) touched.push(c);
  }
  for (const prop of props) {
    const r = resolvePropertyPath(prop, entity.fqn, lookup);
    if (!r.ok) {
      sink.unresolved.push({ reason: 'property-path-unresolved', detail: `${prop}: ${r.reason}` });
      continue;
    }
    const last = r.path[r.path.length - 1];
    const owner = entities.get(last.entity);
    const attr = owner ? owner.attributes.get(last.property) : null;
    if (!owner || !attr || attrColumns(attr).length === 0) {
      sink.unresolved.push({ reason: 'property-has-no-column', detail: `${prop} resolves to ${last.entity}.${last.property}, which owns no column` });
      continue;
    }
    const home = homeOf(owner, attr);
    for (const c of attrColumns(attr)) touched.push({ table: home.table, column: c.column, grade: weakest(home.tableGrade, c.grade) });
    if (!tableGrades.has(home.table)) tableGrades.set(home.table, home.tableGrade);
    // A nested path is a join: every hop's owning table is read on the way.
    for (const hop of r.path.slice(0, -1)) {
      const hopOwner = entities.get(hop.entity);
      if (hopOwner) mark(sink.tableAccess, hopOwner.table, 'read', hopOwner.tableGrade);
    }
  }

  // A query on a SINGLE_TABLE subclass is filtered by the hierarchy's discriminator.
  const discriminator = entity.parent ? discriminatorOf(entity) : null;
  if (discriminator) touched.push(discriminator);
  // A predicate column is READ even by a DELETE (the WHERE clause reads it);
  // the TABLE access is what says the row goes away. Same split lineage.py makes.
  for (const t of touched) {
    sink.reads.push(t);
    mark(sink.tableAccess, t.table, access === 'delete' && t.table === entity.table ? 'delete' : 'read', tableGrades.get(t.table) ?? t.grade);
  }
  markRow(sink.tableAccess, entity, access === 'delete' ? 'delete' : 'read', entity.tableGrade);
  // A SELECT's result IS the entity, so the fetch plan applies to it. A derived
  // DELETE removes rows and returns none, so nothing is fetched with them.
  return { root: access === 'delete' ? null : entity, forced: [] };
}

/**
 * The entity a JPQL `FROM` names: by the entity's name when `@Entity(name = …)`
 * gives it one (that is the only name JPQL knows it by), else by the class.
 */
function jpqlEntityOf(name, ctx) {
  const byName = [...ctx.entities.values()].find((e) => e.entityName === name && e.entityName !== e.simple);
  if (byName) return byName;
  const fqn = ctx.resolveType(ctx.repo.fqn, name) ?? [...ctx.entities.keys()].find((k) => k.endsWith(`.${name}`)) ?? null;
  return fqn ? (ctx.entities.get(fqn) ?? null) : null;
}

/** A JPQL query's aliases and paths, resolved through the entity model. */
function resolveJpqlRefs(read, ctx, sink) {
  const { entities, resolveType } = ctx;
  const lookup = makeLookup(entities, resolveType);

  // alias -> entity. Roots name an entity; a join alias walks an association.
  const aliasEntity = new Map();
  // …and alias -> the path that reached it FROM the first root, so a
  // `JOIN FETCH` written off a join alias is still a path this fetch plan can
  // follow from the entity the query returns.
  const aliasFrom = new Map();
  const forced = [];
  for (const root of read.roots) {
    const target = jpqlEntityOf(root.entity, ctx);
    if (!target) {
      sink.unresolved.push({ reason: 'jpql-entity-unknown', detail: `FROM ${root.entity}: not an @Entity this pack saw` });
      continue;
    }
    aliasEntity.set(root.alias, target);
    aliasFrom.set(root.alias, { root: root.alias, path: [] });
  }
  for (const j of read.joins) {
    const base = aliasEntity.get(j.base);
    if (!base) {
      sink.unresolved.push({ reason: 'jpql-alias-unknown', detail: `JOIN ${j.base}.${j.path.join('.')}: alias ${j.base} is not bound` });
      continue;
    }
    let cur = base;
    let ok = true;
    for (const seg of j.path) {
      const hit = lookup(cur.fqn, seg);
      if (!hit || !hit.associationTo || !entities.has(hit.associationTo)) { ok = false; break; }
      mark(sink.tableAccess, cur.table, 'read', cur.tableGrade);
      cur = entities.get(hit.associationTo);
    }
    if (!ok) {
      sink.unresolved.push({ reason: 'jpql-join-unresolved', detail: `${j.base}.${j.path.join('.')} is not an association chain` });
      continue;
    }
    const from = aliasFrom.get(j.base);
    const reachedBy = from ? { root: from.root, path: [...from.path, ...j.path] } : null;
    if (j.alias && reachedBy) aliasFrom.set(j.alias, reachedBy);
    if (j.alias) aliasEntity.set(j.alias, cur);
    // JOIN FETCH is the query overriding the mapping: the association comes back
    // loaded whatever `fetch =` says, so the whole row on the other side is read.
    if (j.fetch === true && reachedBy && reachedBy.root === (read.roots[0] ?? {}).alias) {
      forced.push({ path: reachedBy.path.join('.'), rule: 'jpql-join-fetch' });
    }
    mark(sink.tableAccess, cur.table, 'read', cur.tableGrade);
  }

  const resolveRef = (ref, bucket) => {
    const owner = aliasEntity.get(ref.alias);
    if (!owner) {
      sink.unresolved.push({ reason: 'jpql-alias-unknown', detail: `${ref.alias}${ref.path.length ? '.' + ref.path.join('.') : ''} is not a bound alias` });
      return;
    }
    if (ref.path.length === 0) {
      // `SELECT o` / `SELECT COUNT(o)` — the whole row.
      for (const c of columnsOf(owner)) sink[bucket].push(c);
      markRow(sink.tableAccess, owner, bucket === 'writes' ? 'write' : 'read', owner.tableGrade);
      return;
    }
    let cur = owner;
    for (let i = 0; i < ref.path.length; i += 1) {
      const seg = ref.path[i];
      const hit = lookup(cur.fqn, seg);
      if (!hit) {
        sink.unresolved.push({ reason: 'jpql-path-unresolved', detail: `${ref.alias}.${ref.path.join('.')}: ${cur.fqn} has no property ${seg}` });
        return;
      }
      const last = i === ref.path.length - 1;
      if (last) {
        const attr = cur.attributes.get(seg);
        if (!attr || attrColumns(attr).length === 0) {
          sink.unresolved.push({ reason: 'jpql-path-has-no-column', detail: `${ref.alias}.${ref.path.join('.')} owns no column` });
          return;
        }
        const home = homeOf(cur, attr);
        sink[bucket].push(...attrColumns(attr).map((c) => ({ table: home.table, column: c.column, grade: weakest(home.tableGrade, c.grade) })));
        mark(sink.tableAccess, home.table, bucket === 'writes' ? 'write' : 'read', home.tableGrade);
        return;
      }
      if (!hit.associationTo || !entities.has(hit.associationTo)) {
        sink.unresolved.push({ reason: 'jpql-path-unresolved', detail: `${ref.alias}.${ref.path.join('.')}: ${seg} is not an association` });
        return;
      }
      mark(sink.tableAccess, cur.table, 'read', cur.tableGrade);
      cur = entities.get(hit.associationTo);
    }
  };

  for (const ref of read.reads) resolveRef(ref, 'reads');
  for (const ref of read.writes) resolveRef(ref, 'writes');
  if (read.kind === 'delete') {
    for (const root of read.roots) {
      const owner = aliasEntity.get(root.alias);
      if (owner) markRow(sink.tableAccess, owner, 'delete', owner.tableGrade);
    }
  }
  // Only a SELECT hands back entities, so only a SELECT has a fetch plan.
  const first = read.roots[0];
  return { root: read.kind === 'select' && first ? (aliasEntity.get(first.alias) ?? null) : null, forced };
}

// ---------------------------------------------------------------------------
// the fetch plan: what one statement really loads
// ---------------------------------------------------------------------------

/**
 * IS THIS ASSOCIATION LOADED WITH ITS OWNER? `fetch =` when the mapping writes
 * it, and the JPA specification's default when it does not: a to-one is EAGER,
 * a to-many is LAZY. `how` says which of the two answered, because a reader
 * deciding how far to trust the reach is entitled to know whether a line of
 * source said it or a specification did.
 */
function effectiveFetch(a) {
  const written = typeof a.fetch === 'string' ? a.fetch.toUpperCase() : null;
  if (written === 'EAGER' || written === 'LAZY') return { eager: written === 'EAGER', how: 'explicit' };
  return { eager: DEFAULT_EAGER_RELATIONS.has(a.relation), how: 'default' };
}

/** The join table one FOLLOWED association crosses, or null when it crosses none. */
function crossedJoinTable(owner, a, target, ctx) {
  if (a.joinTableResolved) return a.joinTableResolved;
  // The inverse side of a @ManyToMany: the OWNING side declared the table, and
  // `mappedBy` names the attribute that did.
  if (a.mappedBy) {
    const owning = target.attributes.get(a.mappedBy);
    return owning && owning.joinTableResolved ? owning.joinTableResolved : null;
  }
  return usesJoinTable(a) ? joinTableOf(homeOf(owner, a), a, target, ctx) : null;
}

/**
 * WHAT ONE STATEMENT REALLY LOADS. A query on an entity does not stop at that
 * entity's own row: every association JPA is told to fetch EAGERLY comes back
 * with it, in the same round trip, and so does everything eager on THOSE rows.
 * petclinic's `Owner.pets` is `fetch = EAGER`, `Pet.type` is a @ManyToOne (eager
 * unless the mapping says otherwise) and `Pet.visits` is eager too, so
 * `findById(1)` reads four tables while naming one.
 *
 * THE QUERY'S OWN PLAN WINS over the mapping: a `JOIN FETCH` and every
 * `@EntityGraph` attribute path is followed whatever `fetch =` says.
 *
 * LAZY STAYS OUT, and is counted. A lazy collection a page touches later IS a
 * read, and it is one this lane cannot see: it happens when the template asks,
 * not when the query runs. Following it would put reads in the answer that many
 * requests never make.
 *
 * @returns {{reached:object[], diagnostics:object[], lazy:number}}
 */
function fetchClosure(root, ctx, forced) {
  const { entities, resolveType } = ctx;
  const reached = [];
  const diagnostics = [];
  let lazy = 0;
  const wanted = forcedIndex(forced);
  const used = new Set();
  const seen = new Set([root.fqn]);
  const queue = [{ entity: root, path: [], depth: 0, grade: 'EXACT' }];
  const hop = (cur, a, rule, fetch) => {
    const targetFqn = a.targetSimple ? resolveType(cur.entity.fqn, a.targetSimple) : null;
    const target = targetFqn ? entities.get(targetFqn) : null;
    if (!target) return; // reported once per mapping by `tableColumnAndJoinNodes`
    if (seen.has(target.fqn)) return; // a mapping that loops back is followed once
    if (cur.depth + 1 > FETCH_DEPTH_CAP) {
      diagnostics.push({
        reason: 'fetch-depth-capped',
        detail: `${root.simple}.${[...cur.path, a.name].join('.')} is more than ${FETCH_DEPTH_CAP} associations deep, so this statement's fetch plan stops here`,
      });
      return;
    }
    seen.add(target.fqn);
    const path = [...cur.path, a.name];
    // A table is reached because the fetch loads it and the mapping names it:
    // the key's NAME is graded on the key's own READS edge (and a join table's
    // on its own columns), never on the table the association reaches.
    const grade = weakest(cur.grade, target.tableGrade);
    reached.push({ entity: target, joinTable: crossedJoinTable(cur.entity, a, target, ctx), path, grade, rule, fetch });
    queue.push({ entity: target, path, depth: cur.depth + 1, grade });
  };
  while (queue.length > 0) {
    const cur = queue.shift();
    for (const a of cur.entity.attributes.values()) {
      if (!a.relation || a.transient === true) continue;
      const key = [...cur.path, a.name].join('.');
      if (wanted.has(key)) { used.add(key); hop(cur, a, wanted.get(key), null); continue; }
      const f = effectiveFetch(a);
      if (!f.eager) { lazy += 1; continue; }
      hop(cur, a, 'jpa-eager-fetch', f.how);
    }
  }
  for (const key of [...wanted.keys()].sort(cmp)) {
    if (used.has(key)) continue;
    diagnostics.push({
      reason: 'fetch-path-unresolved',
      detail: `${root.simple}.${key} (${wanted.get(key)}) names no association of this entity, so nothing was loaded for it`,
    });
  }
  return { reached, diagnostics, lazy };
}

/**
 * The paths a query's own plan forces, keyed by the dotted path from the root.
 * EVERY PREFIX IS FORCED TOO: `@EntityGraph(attributePaths = {"pets.visits"})`
 * cannot load the visits without loading the pets, so asking for the leaf asks
 * for every hop that reaches it.
 */
function forcedIndex(forced) {
  const wanted = new Map();
  for (const f of forced ?? []) {
    const segs = String(f.path ?? '').split('.').filter((s) => s.length > 0);
    for (let i = 1; i <= segs.length; i += 1) {
      const key = segs.slice(0, i).join('.');
      if (!wanted.has(key)) wanted.set(key, f.rule);
    }
  }
  return wanted;
}

/**
 * Everything the fetch plan brings in, added to one statement's reads exactly as
 * the bridge adds the root entity's own: the table it lands on, every mapped
 * column of it, and the join table it crossed to get there.
 * @returns {string[]} the `limits` sentences this statement has to carry
 */
function applyFetchPlan(root, ctx, forced, sink) {
  const { reached, diagnostics, lazy } = fetchClosure(root, ctx, forced);
  for (const r of reached) {
    const evidence = {
      via: r.rule, rule: r.rule, basis: JPA_FETCH_RULE_BASIS[r.rule],
      path: `${root.simple}.${r.path.join('.')}`, ...(r.fetch ? { fetch: r.fetch } : {}),
    };
    if (r.joinTable) {
      ctx.ensureTable(r.joinTable.table, { joinTableFor: [root.fqn, r.entity.fqn] });
      for (const c of r.joinTable.columns) {
        ctx.ensureColumn(c.table, c.column, c.grade);
        sink.reads.push({ ...c, grade: weakest(r.grade, c.grade), evidence });
      }
      mark(sink.tableAccess, r.joinTable.table, 'read', weakest(r.grade, r.joinTable.grade), evidence);
    }
    for (const c of columnsOf(r.entity)) sink.reads.push({ ...c, grade: weakest(r.grade, c.grade), evidence });
    markRow(sink.tableAccess, r.entity, 'read', r.grade, evidence);
  }
  for (const d of diagnostics) sink.unresolved.push(d);
  ctx.stats.lazyAssociationsNotFollowed += lazy;
  return lazy === 0 ? [] : [
    `${lazy} association(s) reachable from ${root.simple} are LAZY, so this statement does not read them. `
    + 'A page that touches one after the query has run makes a second query, and that read is not in this answer.',
  ];
}

/** A CrudRepository built-in: what `save`/`delete`/`findById` do to the row. */
function addBuiltinStatement(g, ctx) {
  const { repoFqn, method, entity, file, stats, tableIdOf, columnIdOf } = ctx;
  const key = statementKey(repoFqn, method);
  const sid = nodeId('statement', key);
  const family = BUILTIN_METHODS[method];
  const sink = { reads: [], writes: [], tableAccess: new Map(), unresolved: polymorphicNote(entity, ctx.entities) };
  let limits = [];
  let evidenceNote;

  if (family === 'save') {
    evidenceNote = 'a JPA save() merges the whole entity, so every mapped column of the row is written';
    for (const c of columnsOf(entity)) sink.writes.push(c);
    markRow(sink.tableAccess, entity, 'write', entity.tableGrade);
    applyCascade(entity, ctx, sink, 'save');
  } else if (family === 'delete') {
    evidenceNote = 'a JPA delete() removes the row; its columns are not individually written';
    markRow(sink.tableAccess, entity, 'delete', entity.tableGrade);
    applyCascade(entity, ctx, sink, 'delete');
  } else if (family === 'findById') {
    evidenceNote = 'a by-id lookup reads the row through its primary key';
    // Every key column, at the table's grade as it always was; a key the tree
    // does not declare at all is an assumed default, and HEURISTIC.
    const keyGrade = weakest(entity.tableGrade, keyAssumedGrade(entity));
    for (const k of entity.pkColumns) sink.reads.push({ table: entity.table, column: k.column, grade: keyGrade });
    if (keyAssumedGrade(entity) !== 'EXACT') {
      sink.unresolved.push({ reason: 'primary-key-assumed', detail: `${entity.fqn} declares no primary key this lane read, so the by-id lookup reads the assumed default \`${entity.pkColumn}\`` });
    }
    markRow(sink.tableAccess, entity, 'read', entity.tableGrade);
    limits = applyFetchPlan(entity, ctx, [], sink);
  } else {
    evidenceNote = 'reads every mapped column of the row';
    for (const c of columnsOf(entity)) sink.reads.push(c);
    markRow(sink.tableAccess, entity, 'read', entity.tableGrade);
    limits = applyFetchPlan(entity, ctx, [], sink);
  }
  emitStatement(g, {
    // The REPOSITORY's file, not the entity's: this statement belongs to the
    // interface the service called, even though no line of it is written down.
    sid, key, type: 'builtin', file: file ?? null, line: null,
    member: `${repoFqn}#${method}`, ...sink, stats,
    tableIdOf, columnIdOf,
    evidence: {
      repository: repoFqn, method, builtin: family, note: evidenceNote,
      ...(limits.length > 0 ? { limits } : {}),
    },
  });
}

/**
 * CASCADE. `@OneToMany(cascade = ALL)` means saving the parent reaches the
 * children, and removing the parent removes them — that is written in the
 * source, so it is not a guess. Whether a given call actually HAS a dirty or a
 * present child is runtime, so the reach is a SOUND candidate set and is capped
 * at SOUND_SET, never EXACT.
 *
 * A delete writes no columns, for the same reason the root delete writes none:
 * the row goes away whole. `orphanRemoval` is not read, so a child a save
 * detaches rather than cascades to is a row this lane does not follow.
 */
function applyCascade(entity, ctx, sink, operation) {
  for (const reached of cascadeClosure(entity, ctx, operation)) {
    const evidence = {
      via: 'jpa-cascade', rule: 'jpa-cascade', basis: JPA_FETCH_RULE_BASIS['jpa-cascade'],
      path: `${entity.simple}.${reached.path.join('.')}`, operation,
    };
    const grade = weakest(reached.grade, 'SOUND_SET');
    if (reached.joinTable) {
      ctx.ensureTable(reached.joinTable.table, { joinTableFor: [entity.fqn, reached.entity.fqn] });
      for (const c of reached.joinTable.columns) ctx.ensureColumn(c.table, c.column, c.grade);
      if (operation === 'save') {
        for (const c of reached.joinTable.columns) sink.writes.push({ ...c, grade: weakest(grade, c.grade), evidence });
      }
      mark(sink.tableAccess, reached.joinTable.table, operation === 'save' ? 'write' : 'delete', weakest(grade, reached.joinTable.grade), evidence);
    }
    if (operation === 'save') {
      for (const c of columnsOf(reached.entity)) sink.writes.push({ ...c, grade: weakest(c.grade, grade), evidence, via: 'jpa-cascade' });
    }
    markRow(sink.tableAccess, reached.entity, operation === 'save' ? 'write' : 'delete', grade, evidence);
  }
}

/** The entities a `save()` or a `delete()` reaches through cascading associations. */
function cascadeClosure(root, ctx, operation = 'save') {
  const { entities, resolveType } = ctx;
  const kinds = operation === 'delete' ? REMOVING_CASCADES : SAVING_CASCADES;
  const out = [];
  const seen = new Set([root.fqn]);
  const queue = [{ entity: root, path: [], depth: 0, grade: 'EXACT' }];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (cur.depth >= FETCH_DEPTH_CAP) continue;
    for (const a of cur.entity.attributes.values()) {
      if (!a.relation || a.transient === true) continue;
      const cascades = Array.isArray(a.cascade) ? a.cascade : [];
      if (!cascades.some((c) => kinds.has(String(c).toUpperCase()))) continue;
      const targetFqn = a.targetSimple ? resolveType(cur.entity.fqn, a.targetSimple) : null;
      const target = targetFqn ? entities.get(targetFqn) : null;
      if (!target || seen.has(target.fqn)) continue;
      seen.add(target.fqn);
      // As a fetch: the cascade and the target's name reach the table, and a
      // derived key name stays on the key's own edge.
      const grade = weakest(cur.grade, target.tableGrade);
      const path = [...cur.path, a.name];
      out.push({ entity: target, path, grade, joinTable: crossedJoinTable(cur.entity, a, target, ctx) });
      queue.push({ entity: target, path, depth: cur.depth + 1, grade });
    }
  }
  return out;
}

/** Attach one statement node with its bindings and access edges. */
function emitStatement(g, a) {
  const { sid, key, type, member, reads, writes, tableAccess, unresolved, stats, tableIdOf, columnIdOf } = a;
  // A NATIVE statement's node was already created by the SQL lane (analyze feeds
  // its text to lineage.py). Keep the verb that analyzer read, under its own key,
  // instead of losing it to the JPA statement type.
  const existing = g.nodes.get(sid);
  const node = {
    id: sid, statementType: type, file: a.file ?? null, line: a.line ?? null,
    source: 'jpa', jpaEvidence: a.evidence ?? null,
    ...(existing && existing.statementType && existing.statementType !== type
      ? { sqlStatementType: existing.statementType } : {}),
  };
  if (unresolved.length > 0) {
    // KEPT, never dropped (SPEC §3.3): a statement whose columns could not all
    // be resolved is still a statement, and the reason travels with it.
    node.hasUnresolved = true;
    node.unresolved = unresolved.map((u) => ({ reason: u.reason, detail: u.detail ?? null }));
  }
  g.addNode(node);
  stats.statements += 1;
  stats.statementsByType[type] = (stats.statementsByType[type] ?? 0) + 1;
  for (const u of unresolved) stats.unresolved.push({ statement: key, reason: u.reason, detail: u.detail ?? null });

  // The mapper-interface rule, unchanged: a repository METHOD *is* the statement
  // Spring Data generates for it — definitional, so EXACT (same as MyBatis).
  const symId = nodeId('symbol', member);
  g.addNode({ id: symId, symbol: member, owner: member.slice(0, member.lastIndexOf('#')), repositoryMethod: true });
  // The Java bridge already binds any symbol whose FQN matches a statement key,
  // which a NATIVE statement's does (the SQL lane created that node). Adding a
  // second identical edge would double the census without adding a fact.
  if (!g.outEdges(symId).some((e) => e.type === 'IMPLEMENTS_STMT' && e.to === sid)) {
    g.addEdge({ from: symId, to: sid, type: 'IMPLEMENTS_STMT', grade: 'EXACT' });
    stats.implementsStmt += 1;
  }

  for (const [table, acc] of [...tableAccess.entries()].sort((x, y) => cmp(x[0], y[0]))) {
    g.addEdge({
      from: sid, to: tableIdOf(table),
      type: 'EXECUTES', grade: acc.grade,
      evidence: { access: acc.access, via: 'jpa', ...(acc.evidence ?? {}) },
    });
  }
  const emitted = new Set();
  for (const [bucket, edgeType] of [[reads, 'READS'], [writes, 'WRITES']]) {
    for (const c of bucket) {
      const cid = columnIdOf(c.table, c.column);
      const dedupe = `${edgeType}|${cid}`;
      if (emitted.has(dedupe)) continue;
      emitted.add(dedupe);
      g.addEdge({
        from: sid, to: cid, type: edgeType, grade: c.grade,
        evidence: c.evidence ?? { via: c.via ?? 'jpa' },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Every mapped column of an entity's row, with its weakest-link grade: its
 * attributes' (a composite key or a foreign key toward one owns one per key
 * column), the foreign keys other mappings put on its table, and the columns
 * the row carries that no attribute declares, an assumed key and a
 * discriminator, each as sure as the default it was named by.
 */
function columnsOf(entity) {
  const out = [];
  const seen = new Set();
  const add = (table, column, grade) => {
    if (seen.has(`${table}.${column}`)) return;
    seen.add(`${table}.${column}`);
    out.push({ table, column, grade });
  };
  for (const a of entity.attributes.values()) {
    const home = homeOf(entity, a);
    for (const c of attrColumns(a)) add(home.table, c.column, weakest(home.tableGrade, c.grade));
  }
  for (const c of entity.inboundColumns ?? []) add(entity.table, c.column, c.grade);
  for (const t of rowTables(entity)) for (const c of t.assumedKey ?? []) add(t.table, c.column, weakest(t.tableGrade, c.grade));
  const d = discriminatorOf(entity);
  if (d) add(d.table, d.column, d.grade);
  return out;
}

/** The `lookup` that `resolvePropertyPath` and the JPQL reader share. */
function makeLookup(entities, resolveType) {
  return (entityFqn, property) => {
    const e = entities.get(entityFqn);
    if (!e) return null;
    const attr = e.attributes.get(property);
    if (!attr) return null;
    let associationTo = null;
    if (attr.relation && attr.targetSimple) {
      const fqn = resolveType(entityFqn, attr.targetSimple);
      if (fqn && entities.has(fqn)) associationTo = fqn;
    }
    return { attribute: attr, ...(associationTo ? { associationTo } : {}) };
  };
}

function mark(map, table, access, grade, evidence = null) {
  const prev = map.get(table);
  // write beats read for the same table (a statement that writes it also touches it)
  const rank = { read: 0, delete: 1, write: 2 };
  if (!prev || rank[access] > rank[prev.access]) map.set(table, { access, grade, evidence });
  // The FIRST evidence for an access is kept: a table the query itself names is
  // marked before the fetch plan runs, and "the query names it" outranks "the
  // fetch plan also reaches it" as the reason it is touched.
  else if (prev.access === access) map.set(table, { access, grade: weakest(prev.grade, grade), evidence: prev.evidence ?? evidence });
}

function addJoin(g, seen, aId, bId, columns, grade, stats) {
  if (aId === bId) return; // a self-association is not an ERD relationship
  const [from, to] = aId < bId ? [aId, bId] : [bId, aId];
  const key = `${from}|${to}`;
  if (seen.has(key) || seen.has(`${to}|${from}`)) return;
  seen.add(key);
  g.addEdge({ from, to, type: 'JOINS', grade, evidence: { via: 'jpa-association', columns: Array.isArray(columns) ? columns : [columns] } });
  stats.joins += 1;
}

function note(stats, reason, detail) {
  stats.unresolved.push({ statement: null, reason, detail });
}

function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

export class JpaBridgeError extends Error {
  constructor(message) { super(message); this.name = 'JpaBridgeError'; }
}
