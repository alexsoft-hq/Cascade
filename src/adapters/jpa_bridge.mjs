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
// Runs AFTER `addJavaFacts` (it needs the symbol nodes) and after the SQL
// bridge (it stitches onto the catalog's table/column nodes). Pure: a Graph and
// a fact array in, the same Graph mutated and a stats object out.

import { nodeId } from '../core/graph.mjs';
import { buildTypeIndex } from './java_bridge.mjs';
import { parseDerivedQuery, resolvePropertyPath } from '../core/derived_query.mjs';
import { readJpql } from '../core/jpql_lite.mjs';
import { tableKey, columnKey, statementKey, graphSpellingIndex } from './sql_bridge.mjs';

/** The naming strategies this bridge can apply. */
export const NAMING_STRATEGIES = Object.freeze(['spring-snake-case', 'identity']);

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

const RANK = Object.freeze({ UNRESOLVED: 0, RUNTIME_ONLY: 1, HEURISTIC: 2, SOUND_SET: 3, EXACT: 4 });
const weakest = (...gs) => gs.reduce((a, b) => (RANK[a] <= RANK[b] ? a : b), 'EXACT');

/**
 * Spring Boot's default physical naming: CamelCase -> snake_case, lower-cased.
 * `lastName` -> `last_name`, `PetType` -> `pet_type`, `URL` -> `url`.
 * @param {string} name
 * @returns {string}
 */
export function snakeCase(name) {
  const s = String(name ?? '');
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    const isUpper = c >= 'A' && c <= 'Z';
    if (isUpper && i > 0) {
      const prev = s[i - 1];
      const next = i + 1 < s.length ? s[i + 1] : '';
      const prevIsLowerOrDigit = /[a-z0-9]/.test(prev);
      const nextIsLower = /[a-z]/.test(next);
      if (prevIsLowerOrDigit || nextIsLower) out += '_';
    }
    out += c.toLowerCase();
  }
  return out;
}

/** The physical name a strategy gives a logical one. */
export function physicalName(logical, strategy) {
  return strategy === 'identity' ? String(logical ?? '') : snakeCase(logical);
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
  const repositories = [];
  const calls = [];
  for (const r of javaFacts) {
    if (!r || typeof r !== 'object') continue;
    if (r.kind === 'entity') entityRecords.set(r.fqn, r);
    else if (r.kind === 'repository') repositories.push(r);
    else if (r.kind === 'call') calls.push(r);
  }

  const stats = {
    entities: 0, mappedSuperclasses: 0, repositories: 0,
    tables: 0, tablesStubbed: 0, columns: 0, columnsStubbed: 0, joins: 0,
    statements: 0, statementsByType: { derived: 0, jpql: 0, native: 0, builtin: 0 },
    implementsStmt: 0, unresolvedStatements: 0, unresolved: [],
    builtins: 0, namingStrategy: strategy, namingStrategyDeclared: declared,
  };
  if (entityRecords.size === 0 && repositories.length === 0) return stats;

  // ---- 1. entities -> tables ----------------------------------------------
  /** @type {Map<string, {fqn, table, tableId, grade, attributes:Map, pkColumn}>} */
  const entities = new Map();
  for (const [fqn, rec] of entityRecords) {
    if (rec.mappedSuperclass === true) stats.mappedSuperclasses += 1;
    if (rec.entity !== true) continue; // @MappedSuperclass / @Embeddable map to no table
    stats.entities += 1;
    const simple = fqn.slice(fqn.lastIndexOf('.') + 1);
    const explicit = typeof rec.tableName === 'string' && rec.tableName.length > 0;
    const table = explicit ? rec.tableName : physicalName(simple, strategy);
    entities.set(fqn, {
      fqn, simple, record: rec,
      table,
      tableGrade: explicit ? 'EXACT' : derivedGrade,
      tableEvidence: explicit ? 'declared' : namingEvidence,
      attributes: null, // filled below, once the superclass chain is walked
      pkColumn: null,
      // Columns on THIS table that another entity's association declares — the
      // foreign key a unidirectional @OneToMany(@JoinColumn) puts on the target.
      // They are as much part of the row as the entity's own attributes, so a
      // `save()` writes them and a `findAll()` reads them.
      inboundColumns: [],
    });
  }

  // ---- 2. attributes, through the @MappedSuperclass chain -----------------
  const attributesOf = (fqn, seen = new Set()) => {
    if (seen.has(fqn)) return []; // a cycle in the extends chain: stop, do not hang
    seen.add(fqn);
    const rec = entityRecords.get(fqn);
    if (!rec) return [];
    const superFqn = rec.superclass ? resolveType(fqn, rec.superclass) : null;
    const inherited = superFqn && entityRecords.has(superFqn) ? attributesOf(superFqn, seen) : [];
    const own = Array.isArray(rec.attributes) ? rec.attributes : [];
    // Base-most first, and a subclass attribute of the same name REPLACES the
    // inherited one (Java's own shadowing rule).
    const byName = new Map();
    for (const a of [...inherited, ...own]) byName.set(a.name, a);
    return [...byName.values()];
  };

  for (const e of entities.values()) {
    const attrs = attributesOf(e.fqn);
    e.attributes = new Map();
    for (const a of attrs) {
      const mapped = mapAttribute(a, { strategy, derivedGrade, namingEvidence });
      e.attributes.set(a.name, { ...a, ...mapped });
      if (a.id === true && mapped.column) e.pkColumn = mapped.column;
    }
  }

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
    if (tnode) {
      tnode.jpaEntity = e.fqn;
      tnode.jpaMappingGrade = e.tableGrade;
    }
    stats.tables += 1;
    for (const a of e.attributes.values()) {
      if (!a.column) continue;
      ensureColumn(e.table, a.column, weakest(e.tableGrade, a.grade));
      stats.columns += 1;
    }
  }

  // Associations -> the physical column that carries them, plus a JOINS edge.
  // The pairs already in the graph (the SQL lane's joins) are indexed once, so
  // adding N associations does not cost N scans of the edge list.
  const joinSeen = new Set();
  for (const edge of g.edges) if (edge.type === 'JOINS') joinSeen.add(`${edge.from}|${edge.to}`);
  for (const e of entities.values()) {
    for (const a of e.attributes.values()) {
      const target = a.targetSimple ? entities.get(resolveType(e.fqn, a.targetSimple) ?? '') : null;
      if (!a.relation) continue;
      if (a.transient === true) continue;
      if (!target) {
        if (a.relation) {
          note(stats, 'association-target-unknown', `${e.fqn}.${a.name}: ${a.targetSimple ?? '?'} is not an @Entity this pack saw`);
        }
        continue;
      }
      const pairGrade = weakest(e.tableGrade, target.tableGrade, a.grade);
      if (a.relation === 'manyToOne' || a.relation === 'oneToOne') {
        if (a.mappedBy) continue; // the OTHER side owns the column
        const col = a.column ?? `${physicalName(a.name, strategy)}_${target.pkColumn ?? 'id'}`;
        // Record the resolved name back on the attribute, so the column this
        // association owns is part of the row every statement reads and writes.
        a.column = col;
        if (!a.grade) a.grade = pairGrade;
        ensureColumn(e.table, col, pairGrade);
        addJoin(g, joinSeen, tableIdOf(e.table), tableIdOf(target.table), `${e.table}.${col}=${target.table}.${target.pkColumn ?? 'id'}`, pairGrade, stats);
      } else if (a.relation === 'oneToMany') {
        // A unidirectional @OneToMany with a @JoinColumn puts the foreign key on
        // the TARGET table (that is what `pets.owner_id` is); with `mappedBy` the
        // other side already declared it. Either way this table gains no column.
        const col = a.joinColumn ?? (a.mappedBy ? null : `${physicalName(e.simple, strategy)}_${e.pkColumn ?? 'id'}`);
        if (col) {
          ensureColumn(target.table, col, pairGrade);
          if (!target.inboundColumns.some((c) => c.column === col)) {
            target.inboundColumns.push({ column: col, grade: pairGrade });
          }
        }
        addJoin(g, joinSeen, tableIdOf(e.table), tableIdOf(target.table), col ? `${e.table}.${e.pkColumn ?? 'id'}=${target.table}.${col}` : `${e.table}~${target.table}`, pairGrade, stats);
      } else if (a.relation === 'manyToMany') {
        if (a.mappedBy) continue; // the owning side declares the join table
        // Each half of a join table is graded on its OWN evidence: the table
        // name, the owning column and the inverse column are three separate
        // declarations, and any one of them may be left to the strategy.
        const jt = a.joinTable;
        const named = !!(jt && jt.name);
        const joinTableName = named ? jt.name : physicalName(`${e.simple}${target.simple}`, strategy);
        const tableNameGrade = named ? 'EXACT' : derivedGrade;
        ensureTable(joinTableName, { joinTableFor: [e.fqn, target.fqn] });
        const leftDeclared = !!(jt && jt.joinColumns && jt.joinColumns[0]);
        const rightDeclared = !!(jt && jt.inverseJoinColumns && jt.inverseJoinColumns[0]);
        const left = leftDeclared ? jt.joinColumns[0] : `${physicalName(e.simple, strategy)}_${e.pkColumn ?? 'id'}`;
        const right = rightDeclared ? jt.inverseJoinColumns[0] : `${physicalName(target.simple, strategy)}_${target.pkColumn ?? 'id'}`;
        const leftGrade = weakest(e.tableGrade, tableNameGrade, leftDeclared ? 'EXACT' : derivedGrade);
        const rightGrade = weakest(target.tableGrade, tableNameGrade, rightDeclared ? 'EXACT' : derivedGrade);
        ensureColumn(joinTableName, left, leftGrade);
        ensureColumn(joinTableName, right, rightGrade);
        addJoin(g, joinSeen, tableIdOf(e.table), tableIdOf(joinTableName), `${e.table}.${e.pkColumn ?? 'id'}=${joinTableName}.${left}`, leftGrade, stats);
        addJoin(g, joinSeen, tableIdOf(target.table), tableIdOf(joinTableName), `${target.table}.${target.pkColumn ?? 'id'}=${joinTableName}.${right}`, rightGrade, stats);
      }
    }
  }

  // I-1, spelled out: a catalog HIT is evidence, never a promotion.
  for (const e of entities.values()) {
    const tnode = g.nodes.get(tableIdOf(e.table));
    if (tnode && tnode.stub !== true) tnode.jpaCatalogMatch = true;
  }

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
      addQueryStatement(g, { repo: rec, method: m, entity, entities, resolveType, stats, tableIdOf, columnIdOf });
    }
  }

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
    addBuiltinStatement(g, { repoFqn, method, entity: r.entity, file: r.rec.file ?? null, entities, resolveType, stats, tableIdOf, columnIdOf });
    stats.builtins += 1;
  }

  stats.unresolvedStatements = new Set(stats.unresolved.filter((u) => u.statement).map((u) => u.statement)).size;
  return stats;
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
  const targetSimple = a.typeArgSimple ?? a.typeSimple ?? null;
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
  if (a.relation === 'oneToMany' || a.relation === 'manyToMany') {
    return { ...base, column: null, grade: explicitJoin || explicitJoinTable ? 'EXACT' : derivedGrade };
  }
  if (a.relation === 'manyToOne' || a.relation === 'oneToOne') {
    if (a.mappedBy) return { ...base, column: null, grade: 'EXACT', reason: 'mappedBy: the other side owns the column' };
    return { ...base, column: explicitJoin ? a.joinColumn : null, grade: explicitJoin ? 'EXACT' : derivedGrade };
  }
  return {
    ...base,
    column: explicitColumn ? a.column : physicalName(a.name, strategy),
    grade: explicitColumn ? 'EXACT' : derivedGrade,
  };
}

// ---------------------------------------------------------------------------
// statements
// ---------------------------------------------------------------------------

function addQueryStatement(g, ctx) {
  const { repo, method, entity, stats } = ctx;
  const key = statementKey(repo.fqn, method.name);
  const sid = nodeId('statement', key);
  const q = method.query;
  const type = q ? (q.native ? 'native' : 'jpql') : 'derived';

  const unresolved = [];
  const reads = [];   // {table, column, grade}
  const writes = [];
  const tableAccess = new Map(); // table -> {access, grade}

  if (type === 'native') {
    // The SQL lane owns a native query: `analyze` feeds its text to lineage.py
    // alongside the mapper statements, so the READS/WRITES on this node come
    // from the same analyzer the MyBatis statements go through. Here we only
    // declare the node and bind the method to it.
    if (!q.text) unresolved.push({ reason: 'empty-native-query', detail: '@Query(nativeQuery=true) carries no SQL' });
  } else if (type === 'jpql') {
    const read = readJpql(q.text ?? '');
    for (const d of read.diagnostics) unresolved.push(d);
    if (read.ok) {
      resolveJpqlRefs(read, ctx, { reads, writes, tableAccess, unresolved });
    } else {
      unresolved.push({ reason: 'jpql-unreadable', detail: String(q.text ?? '').slice(0, 200) });
    }
  } else {
    const parsed = parseDerivedQuery(method.name);
    if (!parsed.ok) {
      unresolved.push({ reason: 'derived-name-unreadable', detail: parsed.reason });
    } else {
      resolveDerivedRefs(parsed, ctx, { reads, writes, tableAccess, unresolved });
    }
  }

  emitStatement(g, {
    sid, key, type, file: repo.file ?? null, line: method.line ?? null,
    member: `${repo.fqn}#${method.name}`, reads, writes, tableAccess, unresolved, stats,
    tableIdOf: ctx.tableIdOf, columnIdOf: ctx.columnIdOf,
    evidence: { repository: repo.fqn, method: method.name, base: repo.base },
  });
}

/** A derived query's predicate/order columns, resolved through the entity model. */
function resolveDerivedRefs(parsed, ctx, sink) {
  const { entity, entities, resolveType, stats } = ctx;
  const access = parsed.access; // 'select' | 'delete'
  const lookup = makeLookup(entities, resolveType);

  const touched = [];
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
    if (!owner || !attr || !attr.column) {
      sink.unresolved.push({ reason: 'property-has-no-column', detail: `${prop} resolves to ${last.entity}.${last.property}, which owns no column` });
      continue;
    }
    touched.push({ table: owner.table, column: attr.column, grade: weakest(owner.tableGrade, attr.grade) });
    // A nested path is a join: every hop's owning table is read on the way.
    for (const hop of r.path.slice(0, -1)) {
      const hopOwner = entities.get(hop.entity);
      if (hopOwner) mark(sink.tableAccess, hopOwner.table, 'read', hopOwner.tableGrade);
    }
  }

  // A predicate column is READ even by a DELETE (the WHERE clause reads it);
  // the TABLE access is what says the row goes away. Same split lineage.py makes.
  for (const t of touched) {
    sink.reads.push(t);
    mark(sink.tableAccess, t.table, access === 'delete' && t.table === entity.table ? 'delete' : 'read', t.grade);
  }
  mark(sink.tableAccess, entity.table, access === 'delete' ? 'delete' : 'read', entity.tableGrade);
}

/** A JPQL query's aliases and paths, resolved through the entity model. */
function resolveJpqlRefs(read, ctx, sink) {
  const { entities, resolveType } = ctx;
  const lookup = makeLookup(entities, resolveType);

  // alias -> entity. Roots name an entity; a join alias walks an association.
  const aliasEntity = new Map();
  for (const root of read.roots) {
    const fqn = resolveType(ctx.repo.fqn, root.entity)
      ?? [...entities.keys()].find((k) => k.endsWith(`.${root.entity}`)) ?? null;
    const target = fqn ? entities.get(fqn) : null;
    if (!target) {
      sink.unresolved.push({ reason: 'jpql-entity-unknown', detail: `FROM ${root.entity}: not an @Entity this pack saw` });
      continue;
    }
    aliasEntity.set(root.alias, target);
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
    if (j.alias) aliasEntity.set(j.alias, cur);
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
      mark(sink.tableAccess, owner.table, bucket === 'writes' ? 'write' : 'read', owner.tableGrade);
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
        if (!attr || !attr.column) {
          sink.unresolved.push({ reason: 'jpql-path-has-no-column', detail: `${ref.alias}.${ref.path.join('.')} owns no column` });
          return;
        }
        sink[bucket].push({ table: cur.table, column: attr.column, grade: weakest(cur.tableGrade, attr.grade) });
        mark(sink.tableAccess, cur.table, bucket === 'writes' ? 'write' : 'read', cur.tableGrade);
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
      if (owner) mark(sink.tableAccess, owner.table, 'delete', owner.tableGrade);
    }
  }
}

/** A CrudRepository built-in: what `save`/`delete`/`findById` do to the row. */
function addBuiltinStatement(g, { repoFqn, method, entity, file, entities, resolveType, stats, tableIdOf, columnIdOf }) {
  const key = statementKey(repoFqn, method);
  const sid = nodeId('statement', key);
  const family = BUILTIN_METHODS[method];
  const reads = [];
  const writes = [];
  const tableAccess = new Map();
  const unresolved = [];
  let evidenceNote = null;

  if (family === 'save') {
    evidenceNote = 'a JPA save() merges the whole entity, so every mapped column of the row is written';
    for (const c of columnsOf(entity)) writes.push(c);
    mark(tableAccess, entity.table, 'write', entity.tableGrade);
    // CASCADE. `@OneToMany(cascade = ALL)` means saving the parent reaches the
    // children — that is written in the source, so it is not a guess. Whether a
    // given call actually has a dirty child is runtime, so the reach is a SOUND
    // candidate set and is capped at SOUND_SET, never EXACT.
    for (const reached of cascadeClosure(entity, entities, resolveType)) {
      for (const c of columnsOf(reached.entity)) {
        writes.push({ ...c, grade: weakest(c.grade, 'SOUND_SET', reached.grade), via: 'jpa-cascade' });
      }
      mark(tableAccess, reached.entity.table, 'write', weakest(reached.grade, 'SOUND_SET'));
    }
  } else if (family === 'delete') {
    evidenceNote = 'a JPA delete() removes the row; its columns are not individually written';
    mark(tableAccess, entity.table, 'delete', entity.tableGrade);
  } else if (family === 'findById') {
    evidenceNote = 'a by-id lookup reads the row through its primary key';
    if (entity.pkColumn) {
      reads.push({ table: entity.table, column: entity.pkColumn, grade: entity.tableGrade });
    } else {
      unresolved.push({ reason: 'no-primary-key', detail: `${entity.fqn} declares no @Id, so the by-id lookup names no column` });
    }
    mark(tableAccess, entity.table, 'read', entity.tableGrade);
  } else {
    evidenceNote = 'reads every mapped column of the row';
    for (const c of columnsOf(entity)) reads.push(c);
    mark(tableAccess, entity.table, 'read', entity.tableGrade);
  }
  emitStatement(g, {
    // The REPOSITORY's file, not the entity's: this statement belongs to the
    // interface the service called, even though no line of it is written down.
    sid, key, type: 'builtin', file: file ?? null, line: null,
    member: `${repoFqn}#${method}`, reads, writes, tableAccess, unresolved, stats,
    tableIdOf, columnIdOf,
    evidence: { repository: repoFqn, method, builtin: family, note: evidenceNote },
  });
}

/** The entities a `save()` reaches through cascading associations. */
function cascadeClosure(root, entities, resolveType) {
  const out = [];
  const seen = new Set([root.fqn]);
  const queue = [{ entity: root, grade: 'EXACT' }];
  while (queue.length > 0) {
    const cur = queue.shift();
    for (const a of cur.entity.attributes.values()) {
      if (!a.relation || a.transient === true) continue;
      const cascades = Array.isArray(a.cascade) ? a.cascade : [];
      if (!cascades.some((c) => SAVING_CASCADES.has(String(c).toUpperCase()))) continue;
      const targetFqn = a.targetSimple ? resolveType(cur.entity.fqn, a.targetSimple) : null;
      const target = targetFqn ? entities.get(targetFqn) : null;
      if (!target || seen.has(target.fqn)) continue;
      seen.add(target.fqn);
      const grade = weakest(cur.grade, a.grade, target.tableGrade);
      out.push({ entity: target, grade });
      queue.push({ entity: target, grade });
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
      type: 'EXECUTES', grade: acc.grade, evidence: { access: acc.access, via: 'jpa' },
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
        evidence: { via: c.via ?? 'jpa' },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Every mapped column of an entity, with its weakest-link grade. */
function columnsOf(entity) {
  const out = [];
  const seen = new Set();
  for (const a of entity.attributes.values()) {
    if (!a.column || seen.has(a.column)) continue;
    seen.add(a.column);
    out.push({ table: entity.table, column: a.column, grade: weakest(entity.tableGrade, a.grade) });
  }
  for (const c of entity.inboundColumns ?? []) {
    if (seen.has(c.column)) continue;
    seen.add(c.column);
    out.push({ table: entity.table, column: c.column, grade: c.grade });
  }
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

function mark(map, table, access, grade) {
  const prev = map.get(table);
  // write beats read for the same table (a statement that writes it also touches it)
  const rank = { read: 0, delete: 1, write: 2 };
  if (!prev || rank[access] > rank[prev.access]) map.set(table, { access, grade });
  else if (prev.access === access) map.set(table, { access, grade: weakest(prev.grade, grade) });
}

function addJoin(g, seen, aId, bId, columns, grade, stats) {
  if (aId === bId) return; // a self-association is not an ERD relationship
  const [from, to] = aId < bId ? [aId, bId] : [bId, aId];
  const key = `${from}|${to}`;
  if (seen.has(key) || seen.has(`${to}|${from}`)) return;
  seen.add(key);
  g.addEdge({ from, to, type: 'JOINS', grade, evidence: { via: 'jpa-association', columns: [columns] } });
  stats.joins += 1;
}

function note(stats, reason, detail) {
  stats.unresolved.push({ statement: null, reason, detail });
}

function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

export class JpaBridgeError extends Error {
  constructor(message) { super(message); this.name = 'JpaBridgeError'; }
}
