// mp_bridge.mjs — MyBatis-Plus entities, generic CRUD and condition wrappers
// become graph facts (SPEC §3.1, §8.3, §18.2).
//
// THE PROBLEM THIS LANE EXISTS FOR. MyBatis writes its SQL down, so a statement
// names its table and its columns. JPA writes nothing down but at least declares
// a repository METHOD per query. MyBatis-Plus writes down LESS than either:
//
//     sysUserDepartMapper.selectList(
//         new LambdaQueryWrapper<SysUserDepart>().eq(SysUserDepart::getDepId, id));
//
// There is no SQL text and no method name to read. The table comes from a
// GLOBAL naming rule applied to the class `SysUserDepart`, the column from the
// same rule applied to the JavaBeans property behind `getDepId`, and the verb
// from the fact that `selectList` is a method of `BaseMapper<T>` that this
// project never wrote. Measured on jeecg-boot, 764 of 978 endpoints reached no
// statement at all before this lane existed — not because their code touches no
// table, but because everything it touches is spelled this way.
//
// This bridge reads it the way MyBatis-Plus does at run time, and — the whole
// point — says which half of that it actually KNOWS:
//
//   @TableName("sys_user_depart")           -> EXACT, declared.
//   @TableField("dep_id")                   -> EXACT, declared.
//   SysUser -> sys_user by the strategy the PROFILE declares      -> EXACT.
//   SysUser -> sys_user because the profile declares nothing and
//              MyBatis-Plus's default is camelCase -> underscore  -> HEURISTIC.
//   the columns of a wrapper built from request.getParameterMap() -> RUNTIME_ONLY:
//              no column edge is emitted, the STATEMENT says so, and
//              `column_impact` on any column of that table says so too.
//
// I-1 (MUST): a HEURISTIC mapping is NEVER promoted, and a catalog hit does not
// promote it. That the derived table name happens to be in the DDL is recorded
// as `evidence.catalogMatch`, and nothing more.
//
// Runs AFTER `addJavaFacts` (it needs the symbol nodes and the call records) and
// after the SQL bridge (it stitches onto the catalog's table/column nodes).
// Pure: a Graph and a fact array in, the same Graph mutated and a stats object
// out. No filesystem, no workers.

import { nodeId } from '../core/graph.mjs';
import { buildTypeIndex, buildHierarchyIndex } from './java_bridge.mjs';
import { snakeCase } from './jpa_bridge.mjs';
import { tableKey, columnKey, statementKey, graphSpellingIndex } from './sql_bridge.mjs';

/** The physical naming strategies `mybatisPlus.namingStrategy` may name. */
export const MP_NAMING_STRATEGIES = Object.freeze(['underscore', 'identity']);

/** What an undeclared `mybatisPlus.namingStrategy` is ASSUMED to be (MP's default). */
export const ASSUMED_MP_NAMING_STRATEGY = 'underscore';

/**
 * The `BaseMapper<T>` methods this lane reads as a statement, and the ACCESS
 * each performs. `getCustomSqlSegment`, `selectMaps`… that only reshape the
 * result are still statements — they run SQL — but a method that runs none
 * (`getBaseMapper`, `lambdaQuery`) is deliberately absent: giving it a statement
 * would invent a row-touching fact.
 */
export const MAPPER_BUILTINS = Object.freeze({
  insert: 'insert',
  deleteById: 'deleteById', deleteBatchIds: 'deleteById', deleteByMap: 'delete', delete: 'delete',
  updateById: 'updateById', update: 'update',
  selectById: 'selectById', selectBatchIds: 'selectById',
  selectByMap: 'select', selectOne: 'select', selectCount: 'select', selectList: 'select',
  selectMaps: 'select', selectObjs: 'select', selectPage: 'select', selectMapsPage: 'select',
  exists: 'select',
});

/** The `IService<T>` / `ServiceImpl<M, T>` methods this lane reads as a statement. */
export const SERVICE_BUILTINS = Object.freeze({
  save: 'insert', saveBatch: 'insert',
  saveOrUpdate: 'save-or-update', saveOrUpdateBatch: 'save-or-update',
  removeById: 'deleteById', removeByIds: 'deleteById', removeBatchByIds: 'deleteById',
  removeByMap: 'delete', remove: 'delete',
  updateById: 'updateById', updateBatchById: 'updateById', update: 'update',
  getById: 'selectById', listByIds: 'selectById',
  getOne: 'select', getOneOpt: 'select', getMap: 'select', getObj: 'select',
  list: 'select', listByMap: 'select', listMaps: 'select', listObjs: 'select',
  count: 'select', page: 'select', pageMaps: 'select', exists: 'select',
});

/**
 * WHAT THIS LANE READS A WRAPPER OP AS. Total by construction: an op outside
 * every set below is `uninterpreted`, and `stats.opsUninterpreted` names it —
 * a lane that quietly ignored an op would report a narrower column set than the
 * code has and give no sign it had done so.
 *
 *  - `column`      the op names ONE column: its first string-literal argument
 *                  (after MP's optional leading `boolean condition`), or the
 *                  method references it carries.
 *  - `columns`     the op names SEVERAL: every top-level string literal.
 *  - `write`       the columns it names are WRITTEN, not read (`set`).
 *  - `sql`         its string argument is a raw SQL FRAGMENT, not a column name.
 *  - `structural`  it names no column of its own (`and`, `or`, `nested`,
 *                  `lambda`): any method reference INSIDE it still names a
 *                  column, because `X::getY` is unambiguous wherever it appears.
 */
export const OP_KINDS = Object.freeze({
  eq: 'column', ne: 'column', gt: 'column', ge: 'column', lt: 'column', le: 'column',
  in: 'column', notIn: 'column',
  like: 'column', notLike: 'column', likeLeft: 'column', likeRight: 'column',
  notLikeLeft: 'column', notLikeRight: 'column',
  between: 'column', notBetween: 'column', isNull: 'column', isNotNull: 'column',
  select: 'columns', groupBy: 'columns', orderByAsc: 'columns', orderByDesc: 'columns', orderBy: 'columns',
  set: 'write', setIncrBy: 'write', setDecrBy: 'write',
  setSql: 'sql', apply: 'sql', last: 'sql', exists: 'sql', notExists: 'sql',
  having: 'sql', inSql: 'sql', notInSql: 'sql',
  and: 'structural', or: 'structural', not: 'structural', nested: 'structural',
  lambda: 'structural', func: 'structural', clone: 'structural',
  getCustomSqlSegment: 'structural', getSqlSegment: 'structural',
});

/** The ops whose columns are WRITTEN by the statement rather than read. */
const WRITE_OPS = new Set(Object.entries(OP_KINDS).filter(([, k]) => k === 'write').map(([n]) => n));

const RANK = Object.freeze({ UNRESOLVED: 0, RUNTIME_ONLY: 1, HEURISTIC: 2, SOUND_SET: 3, EXACT: 4 });
const weakest = (...gs) => gs.reduce((a, b) => (RANK[a] <= RANK[b] ? a : b), 'EXACT');
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The physical name a strategy gives a logical one, plus the project's table prefix. */
export function mpPhysicalName(logical, strategy) {
  return strategy === 'identity' ? String(logical ?? '') : snakeCase(logical);
}

/**
 * STEPS 0-3 OF THE LANE, ON THEIR OWN: the fact index, the generic-base walk
 * that says which class is an entity, and the entity -> table / field -> column
 * mapping.
 *
 * Extracted because TWO callers need exactly this and must not derive it twice.
 * `addMybatisPlusFacts` builds the graph from it; `wrapperFragmentStatements`
 * needs the same table names BEFORE the graph exists, to write a raw wrapper
 * fragment into a statement the SQL analyzer can read. A second copy of the
 * naming rules would be a second chance to disagree about which table a
 * fragment filters.
 *
 * Pure: facts in, a model out. Touches no graph.
 *
 * @param {object[]} javaFacts
 * @param {object} [opts]  the same options `addMybatisPlusFacts` takes
 * @returns {object} `{empty, stats, entities, wrapperRecords, calls, types,
 *          resolveType, implementorsOf, bindingsOf, declares, roleOf, schema, …}`
 */
export function readEntityModel(javaFacts, opts = {}) {
  if (!Array.isArray(javaFacts)) throw new MpBridgeError('javaFacts must be an array');

  const declared = opts.namingStrategy != null;
  const strategy = declared ? opts.namingStrategy : ASSUMED_MP_NAMING_STRATEGY;
  if (!MP_NAMING_STRATEGIES.includes(strategy)) {
    throw new MpBridgeError(`unknown mybatisPlus.namingStrategy ${JSON.stringify(opts.namingStrategy)}. Expected one of ${MP_NAMING_STRATEGIES.join(', ')}`);
  }
  const derivedGrade = declared ? 'EXACT' : 'HEURISTIC';
  const namingEvidence = declared ? 'declared' : 'assumed-mp-default';
  const tablePrefix = typeof opts.tablePrefix === 'string' ? opts.tablePrefix : '';
  const schema = opts.schema ?? null;

  const stats = emptyStats(strategy, declared);

  // ---- 0. index the fact stream -------------------------------------------
  const entityRecords = new Map(); // fqn -> mpEntity record
  const mapperRecords = new Map(); // fqn -> mpMapper record
  const serviceRecords = new Map(); // fqn -> mpService record (the strongest base wins)
  const wrapperRecords = [];
  const calls = [];
  for (const r of javaFacts) {
    if (!r || typeof r !== 'object') continue;
    switch (r.kind) {
      case 'mpEntity': entityRecords.set(r.fqn, r); break;
      case 'mpMapper': mapperRecords.set(r.fqn, r); break;
      case 'mpService': if (!serviceRecords.has(r.fqn)) serviceRecords.set(r.fqn, r); break;
      case 'mpWrapper': wrapperRecords.push(r); break;
      case 'call': calls.push(r); break;
      default:
    }
  }
  if (entityRecords.size === 0 && mapperRecords.size === 0 && serviceRecords.size === 0) {
    return { empty: true, stats, strategy, declared, derivedGrade, namingEvidence, tablePrefix, schema };
  }

  const { types, resolveType } = buildTypeIndex(javaFacts);
  const { implementorsOf, bindingsOf, declares } = buildHierarchyIndex(types, resolveType);

  // ---- 1. who names an entity, through the generic bases ------------------
  //
  // A project rarely extends `ServiceImpl<M, T>` directly. jeecg-boot puts its
  // own `JeecgServiceImpl<M extends BaseMapper<T>, T extends JeecgEntity>
  // extends ServiceImpl<M, T>` in between, and 24 services extend THAT. The
  // worker records only what each file says (`JeecgServiceImpl`'s entity
  // argument is its own type parameter `T`), so the entity is resolved HERE by
  // substituting type arguments down the extends/implements chain — no
  // project-specific base name is ever hardcoded, which is what makes the same
  // rule work for any other project's own base class.
  const roleMemo = new Map(); // fqn -> {role, entity:{concrete|param}} | null
  const roleOf = (fqn, depth = 0) => {
    if (roleMemo.has(fqn)) return roleMemo.get(fqn);
    if (depth > 16) return null; // a fact set assembled from shards need not be acyclic
    roleMemo.set(fqn, null); // cycle guard: an in-progress type answers "unknown"
    const t = types.get(fqn);
    const own = mapperRecords.get(fqn) ?? serviceRecords.get(fqn) ?? null;
    let out = null;
    if (own) {
      const role = own.kind === 'mpMapper' ? 'mapper' : 'service';
      out = { role, entity: bindEntity(fqn, own.entityTypeSimple, t, resolveType) };
    } else if (t) {
      // Walk `extends`, then each `implements`, and take the first supertype
      // that is one. Deterministic: the clauses are read in source order.
      const supers = [];
      if (t.extendsSimple) supers.push({ simple: t.extendsSimple, args: t.extendsArgs ?? [] });
      (t.implementsSimple ?? []).forEach((s, i) => supers.push({ simple: s, args: (t.implementsArgs ?? [])[i] ?? [] }));
      for (const sup of supers) {
        const supFqn = resolveType(fqn, sup.simple);
        if (!supFqn) continue;
        const base = roleOf(supFqn, depth + 1);
        if (!base) continue;
        let entity = base.entity;
        if (entity && entity.param != null) {
          const arg = sup.args[entity.param];
          entity = arg ? bindEntity(fqn, arg, t, resolveType) : null;
        }
        out = { role: base.role, entity };
        break;
      }
    }
    roleMemo.set(fqn, out);
    return out;
  };

  // ---- 2. entities -> tables ----------------------------------------------
  //
  // A class is an MP ENTITY when the source says so in one of exactly two ways:
  // it carries `@TableName`, or a `BaseMapper<T>` / `IService<T>` /
  // `ServiceImpl<M, T>` in this pack names it as T. A class that merely carries
  // `@TableField` on a couple of fields is NOT one — jeecg-boot has six of
  // those, every one a DTO shaped for a result map — and mapping them would
  // have invented six tables that no schema has.
  const namedByGeneric = new Set();
  for (const fqn of [...mapperRecords.keys(), ...serviceRecords.keys(), ...types.keys()]) {
    const r = roleOf(fqn);
    if (r && r.entity && r.entity.concrete) namedByGeneric.add(r.entity.concrete);
  }
  const entities = new Map(); // fqn -> resolved entity
  for (const [fqn, rec] of [...entityRecords].sort((a, b) => cmp(a[0], b[0]))) {
    const declaredName = rec.tableNameDeclared === true && typeof rec.tableName === 'string' && rec.tableName.length > 0;
    if (!declaredName && !namedByGeneric.has(fqn)) {
      note(stats, 'mp-entity-not-mapped',
        `${fqn} carries MyBatis-Plus field annotations but no @TableName, and no BaseMapper/IService/ServiceImpl in this pack names it as its entity, so it maps to no table here`);
      continue;
    }
    const simple = fqn.slice(fqn.lastIndexOf('.') + 1);
    const table = declaredName ? rec.tableName : tablePrefix + mpPhysicalName(simple, strategy);
    entities.set(fqn, {
      fqn, simple, record: rec,
      table,
      tableGrade: declaredName ? 'EXACT' : derivedGrade,
      tableEvidence: declaredName ? 'declared' : namingEvidence,
      schema: rec.schema ?? schema,
      fields: null, // filled below, once the superclass chain is walked
      idColumns: [],
      logicColumn: null,
    });
    stats.entities += 1;
    if (declaredName) stats.entitiesTableDeclared += 1;
  }
  // An entity a mapper/service NAMES but whose class carries no MP annotation at
  // all has no mpEntity record and therefore no field list. It is reported, not
  // silently skipped: its statements would otherwise name no column and nobody
  // would be told why.
  for (const fqn of [...namedByGeneric].sort(cmp)) {
    if (entities.has(fqn)) continue;
    stats.entitiesWithoutFields += 1;
    note(stats, 'mp-entity-fields-unknown',
      `${fqn} is named as a MyBatis-Plus entity but this pack holds no field list for it (the class carries no MP annotation, or the lane never parsed it), so statements on it name no column`);
  }

  // ---- 3. fields -> columns, through the `extends` chain ------------------
  const fieldsOf = (fqn, seen = new Set()) => {
    if (seen.has(fqn)) return [];
    seen.add(fqn);
    const rec = entityRecords.get(fqn);
    if (!rec) return [];
    const superFqn = rec.superclass ? resolveType(fqn, rec.superclass) : null;
    const inherited = superFqn && entityRecords.has(superFqn) ? fieldsOf(superFqn, seen) : [];
    const byName = new Map();
    for (const f of [...inherited, ...(Array.isArray(rec.fields) ? rec.fields : [])]) byName.set(f.name, f);
    return [...byName.values()];
  };

  for (const e of entities.values()) {
    e.fields = new Map();
    for (const f of fieldsOf(e.fqn)) {
      const mapped = mapField(f, { strategy, derivedGrade, namingEvidence });
      e.fields.set(f.name, { ...f, ...mapped });
      if (mapped.column) {
        stats.columns += 1;
        if (f.id === true) e.idColumns.push(mapped.column);
        if (f.logic === true) e.logicColumn = { column: mapped.column, grade: mapped.grade };
      }
    }
    if (e.logicColumn) stats.logicDeleteEntities += 1;
  }


  return {
    empty: false, stats,
    entityRecords, mapperRecords, serviceRecords, wrapperRecords, calls,
    types, resolveType, implementorsOf, bindingsOf, declares, roleOf, entities,
    strategy, declared, derivedGrade, namingEvidence, tablePrefix, schema,
  };
}

/**
 * Add MyBatis-Plus facts to a graph that already carries the SQL catalog and the
 * Java lane's symbols and calls.
 *
 * @param {import('../core/graph.mjs').Graph} g
 * @param {object[]} javaFacts  cascade:javafacts:6 records
 * @param {{namingStrategy?:(string|null), tablePrefix?:(string|null),
 *          logicDeleteValue?:(string|null), logicNotDeleteValue?:(string|null),
 *          schema?:(string|null), identifierCase?:(string|null),
 *          fragmentLineage?:(object[]|null)}} [opts]
 *        `identifierCase` is the SQL identity rule this run matched names with —
 *        the SAME one the lineage worker and the SQL bridge were given. Without
 *        it, jeecg-boot's `sys_user_depart`, whose DDL spells the key column
 *        `ID` while the entity derives `id`, comes out as TWO column nodes for
 *        one column, and a column answer about either is missing half its
 *        statements.
 *        `namingStrategy` null means the profile declares none — the bridge then
 *        assumes MyBatis-Plus's default and grades every derived name HEURISTIC.
 *        `fragmentLineage` is the lineage the SQL analyzer produced for the raw
 *        SQL fragments this lane wrote out with `wrapperFragmentStatements` —
 *        the records let a wrapper's `apply(...)` / `setSql(...)` contribute
 *        real table and column facts instead of only a warning.
 * @returns {object} stats
 */
export function addMybatisPlusFacts(g, javaFacts, opts = {}) {
  if (!g || !g.nodes || !Array.isArray(g.edges)) throw new MpBridgeError('g must be a Graph');

  // Steps 0-3 — the fact index, the generic-base walk, entities -> tables and
  // fields -> columns — are `readEntityModel`, shared with
  // `wrapperFragmentStatements` so the SQL fragments a wrapper carries are
  // synthesised against exactly the tables this bridge will attach them to.
  const model = readEntityModel(javaFacts, opts);
  const stats = model.stats;
  if (model.empty) return stats;
  const {
    entities, wrapperRecords, calls, types, resolveType,
    implementorsOf, bindingsOf, declares, roleOf, schema,
  } = model;

  // ---- 4. table / column nodes -------------------------------------------
  //
  // THE CATALOG'S OWN SPELLING WINS. The SQL bridge keyed every table and column
  // node by what the DDL wrote; the naming rule here derives `id` where the DDL
  // says `ID`. Matched through the SAME fold the SQL lane used, the derived name
  // lands on the catalog's node; matched by string, it would create a second
  // node for the same column and split every answer about it in half. A name the
  // catalog does not have at all keeps its own spelling and becomes a stub,
  // exactly as in the SQL bridge.
  // The fold itself lives in ONE place (`graphSpellingIndex`, sql_bridge.mjs);
  // the JPA bridge calls the same helper for the same reason.
  const { settle, register } = graphSpellingIndex(g, opts.identifierCase ?? 'exact');
  const tableIdOf = (e, name) => settle(nodeId('table', tableKey(e ? e.schema : schema, name)));
  const columnIdOf = (e, table, column) => settle(nodeId('column', columnKey(e ? e.schema : schema, table, column)));

  const seenTables = new Set();
  const seenInCatalog = new Set();
  const ensureTable = (e) => {
    const id = tableIdOf(e, e.table);
    if (!g.nodes.has(id)) {
      g.addNode({ id, stub: true, declaredBy: 'mybatis-plus', mappedFrom: e.fqn });
      stats.tablesStubbed += 1;
    }
    const n = g.nodes.get(id);
    // TWO CLASSES CAN MAP TO ONE TABLE, and in jeecg-boot two do: the sharding
    // test module's `@TableName("sys_log") ShardingSysLog` names the same row as
    // `SysLog`. Writing `mpEntity` twice would have left the node naming
    // whichever class came last in the fact stream — an attribute that depends
    // on arrival order, which is exactly the defect RM11 found on mall's
    // endpoints. So the node LISTS them, sorted, and its mapping grade is the
    // WEAKEST of the two: the reader is told the table is claimed twice instead
    // of being shown one of the claims.
    if (n.mpEntity && n.mpEntity !== e.fqn) {
      const all = [...new Set([...(n.mpEntities ?? [n.mpEntity]), e.fqn])].sort(cmp);
      n.mpEntities = all;
      n.mpEntity = all[0];
      n.mpMappingGrade = weakest(n.mpMappingGrade ?? 'EXACT', e.tableGrade);
      stats.tableNameCollisions += 1;
      note(stats, 'mp-table-claimed-twice',
        `${e.table} is the table of ${all.join(' and ')}. Two MyBatis-Plus entities map to one row, so a statement on either reaches the same columns. The table's mapping grade is the weaker of the two`);
    } else {
      n.mpEntity = e.fqn;
      n.mpMappingGrade = e.tableGrade;
    }
    // I-1, spelled out: a catalog HIT is evidence, never a promotion.
    if (n.stub !== true && n.mpCatalogMatch !== true) { n.mpCatalogMatch = true; stats.tablesInCatalog += 1; }
    seenTables.add(id);
    return id;
  };
  const ensureColumn = (e, table, column, grade) => {
    const cid = columnIdOf(e, table, column);
    if (!g.nodes.has(cid)) {
      g.addNode({ id: cid, name: column, stub: true, declaredBy: 'mybatis-plus' });
      g.addEdge({ from: tableIdOf(e, table), to: cid, type: 'DECLARES', grade });
      stats.columnsStubbed += 1;
      // A stub the derived name INVENTED still has to be findable by the fold,
      // or the next entity that derives the same name would make a third node.
      register(cid);
    } else if (g.nodes.get(cid).stub !== true && !seenInCatalog.has(cid)) {
      // Counted ONCE per column, not once per statement that reaches it: how
      // many of the names this lane derived the DB really has is a fact about
      // the mapping, and multiplying it by the traffic would make it a
      // different, meaningless number.
      seenInCatalog.add(cid);
      stats.columnsInCatalog += 1;
    }
    return cid;
  };
  for (const e of [...entities.values()].sort((a, b) => cmp(a.fqn, b.fqn))) {
    ensureTable(e);
    for (const f of e.fields.values()) {
      if (!f.column) continue;
      ensureColumn(e, e.table, f.column, weakest(e.tableGrade, f.grade));
    }
  }

  // ---- 5. wrappers -> the columns a statement touches ---------------------
  //
  // The lineage the SQL analyzer produced for this project's wrapper SQL
  // fragments, keyed the way `wrapperFragmentStatements` named them. Absent
  // (no fragments, no python, an older caller) the lane behaves as it did
  // before RM17: the fragment is reported, not read.
  const fragmentLineage = new Map();
  for (const r of opts.fragmentLineage ?? []) {
    if (r && r.kind === 'lineage') fragmentLineage.set(`${r.namespace}.${r.id}`, r);
  }
  const fragmentBases = wrapperFragmentBases(wrapperRecords);
  const wrappersByCall = new Map(); // "from|receiver|method" -> [resolvedWrapper]
  for (const w of wrapperRecords) {
    const resolved = readWrapper(w, { entities, resolveType, stats, fragmentBases });
    for (const s of w.sinks ?? []) {
      const receiver = s.kind === 'this' ? 'this' : (s.receiver ?? null);
      const key = `${w.from}|${receiver}|${s.method}`;
      const list = wrappersByCall.get(key);
      if (list) list.push(resolved); else wrappersByCall.set(key, [resolved]);
    }
    if (!Array.isArray(w.sinks) || w.sinks.length === 0) stats.wrappersWithoutSink += 1;
  }

  // ---- 6. calls -> statements --------------------------------------------
  //
  // Every MP built-in a caller REACHED, keyed by the (owner, method) pair that
  // names the statement — so ten call sites on `SysUserMapper#selectList` are
  // ONE statement whose column set is the union of what those ten sites can
  // touch. That union is the sound direction: a statement that could touch a
  // column and did not say so would be the one omission this engine must not
  // make.
  const wanted = new Map(); // statement key -> {ownerFqn, method, verb, entity, wrappers[], callers[]}
  for (const c of calls) {
    if (!c || !c.from || !c.method) continue;
    const ownerFqn = c.from.slice(0, c.from.lastIndexOf('#'));
    for (const targetFqn of callTargets(c, ownerFqn, { types, resolveType, bindingsOf })) {
      const r = roleOf(targetFqn);
      if (!r || !r.entity || !r.entity.concrete) continue;
      const table = MAPPER_BUILTINS_FOR(r.role);
      const verb = Object.hasOwn(table, c.method) ? table[c.method] : null;
      if (!verb) continue;
      // A type that DECLARES the method itself has overridden the built-in: the
      // call runs the project's own code (and, for a mapper, its own XML
      // statement), so claiming the generic one here would put a second, wrong
      // statement under an id the SQL lane already owns.
      if (declares(targetFqn, c.method, null)) {
        stats.builtinsOverridden += 1;
        note(stats, 'mp-builtin-overridden',
          `${targetFqn}#${c.method} is declared by the type itself, so the call runs that method and not MyBatis-Plus's built-in, so no generic statement was created for it`);
        continue;
      }
      for (const owner of statementOwners(targetFqn, r, { types, implementorsOf, roleOf })) {
        const key = statementKey(owner, c.method);
        let w = wanted.get(key);
        if (!w) {
          w = { key, ownerFqn: owner, method: c.method, verb, entity: r.entity.concrete, wrappers: [], callers: [], noWrapperCall: false };
          wanted.set(key, w);
        }
        w.callers.push(c.from);
        const hit = wrappersByCall.get(`${c.from}|${c.receiver ?? null}|${c.method}`);
        if (hit) w.wrappers.push(...hit);
        else w.noWrapperCall = true;
      }
    }
  }

  for (const key of [...wanted.keys()].sort(cmp)) {
    const w = wanted.get(key);
    const entity = entities.get(w.entity) ?? null;
    if (!entity) {
      note(stats, 'mp-statement-entity-unmapped',
        `${key}: the entity ${w.entity} maps to no table in this pack, so the statement names none`);
      continue;
    }
    emitBuiltinStatement(g, {
      stmt: w, entity, stats, tableIdOf, columnIdOf, ensureColumn,
      logicDeleteValue: opts.logicDeleteValue ?? null,
      logicNotDeleteValue: opts.logicNotDeleteValue ?? null,
      types, resolveCtx: { entities, resolveType, stats },
      fragmentLineage,
    });
  }

  // DISTINCT table nodes, which is not the same as the entity count: two
  // entities can map to one table (`sys_log` in jeecg-boot), and saying "64
  // tables" for 63 rows would be a number nobody could reconcile with the graph.
  stats.tables = seenTables.size;
  stats.unresolvedStatements = new Set(stats.unresolved.filter((u) => u.statement).map((u) => u.statement)).size;
  stats.opsUninterpreted = Object.fromEntries([...stats._uninterpreted.entries()].sort((a, b) => cmp(a[0], b[0])));
  stats.opsStructural = Object.fromEntries([...stats._structural.entries()].sort((a, b) => cmp(a[0], b[0])));
  delete stats._uninterpreted;
  delete stats._structural;
  return stats;
}

// ---------------------------------------------------------------------------
// entity / field mapping
// ---------------------------------------------------------------------------

function MAPPER_BUILTINS_FOR(role) {
  return role === 'mapper' ? MAPPER_BUILTINS : SERVICE_BUILTINS;
}

/**
 * A generic argument as either a CONCRETE type or the INDEX of the declaring
 * type's own type parameter — the two things `ServiceImpl<M, T>`'s `T` can be.
 */
function bindEntity(fqn, simple, t, resolveType) {
  if (!simple) return null;
  const params = (t && t.typeParams) ? t.typeParams : [];
  const i = params.indexOf(simple);
  if (i >= 0) return { param: i };
  const concrete = resolveType(fqn, simple);
  return concrete ? { concrete } : null;
}

/**
 * The physical column one field maps to, and how sure that is.
 * `column: null` means the field owns no column — MyBatis-Plus's own rule:
 * `static`, `transient` and `@TableField(exist = false)` are not persisted.
 */
function mapField(f, { strategy, derivedGrade, namingEvidence }) {
  if (f.static === true) return { column: null, grade: 'EXACT', reason: 'a static field is not a column' };
  if (f.transient === true) return { column: null, grade: 'EXACT', reason: 'a transient field is not a column' };
  if (f.exist === false) return { column: null, grade: 'EXACT', reason: '@TableField(exist = false)' };
  const explicit = typeof f.column === 'string' && f.column.length > 0;
  return {
    column: explicit ? f.column : mpPhysicalName(f.name, strategy),
    grade: explicit ? 'EXACT' : derivedGrade,
    evidence: explicit ? 'declared' : namingEvidence,
  };
}

// ---------------------------------------------------------------------------
// wrappers
// ---------------------------------------------------------------------------

/**
 * One `mpWrapper` record READ — which entity it filters, and which column each
 * of its ops names — WITHOUT yet deciding what those columns are.
 *
 * The split matters. `JeecgController<T, S extends IService<T>>.exportXls`
 * builds `QueryWrapper<T>`: read on its own, `T` is a type parameter and the
 * wrapper's entity is unknowable. Read AT THE STATEMENT, the entity is whatever
 * the subclass bound — a different, known answer per binding. So the wrapper is
 * parsed once and RESOLVED per statement, against that statement's entity.
 *
 * A wrapper whose ops this lane cannot see (`QueryGenerator.initQueryWrapper(
 * object, request.getParameterMap())` builds one from the HTTP query string) is
 * not a failure to report as silence: the table is still known, and the honest
 * answer is "this statement touches that table with columns decided at run
 * time". That is `runtimeOnly`, and it travels to the statement node and on into
 * `column_impact`'s limits.
 */
function readWrapper(w, ctx) {
  const { entities, resolveType, stats } = ctx;
  stats.wrappers += 1;
  const ownerFqn = w.from.slice(0, w.from.lastIndexOf('#'));
  const out = {
    from: w.from, var: w.var ?? null, kind: w.wrapperKind ?? 'unknown', line: w.line ?? null,
    ownerFqn, entity: null, entityFrom: null,
    reads: [], writes: [], selects: [], fragments: [],
    runtimeOnly: false, runtimeReason: null, unresolved: [],
  };

  const own = wrapperEntity(w, { entities, resolveType });
  out.entity = own.entity;
  out.entityFrom = own.from;

  if (w.opsComplete !== true) {
    out.runtimeOnly = true;
    out.runtimeReason = w.builtBy
      ? `the wrapper is built by ${w.builtBy}(…), whose conditions this lane cannot read. MyBatis-Plus decides the columns at run time`
      : `the wrapper arrives already built (${w.origin}), so the conditions added outside this method are not in this pack`;
    stats.wrappersRuntimeOnly += 1;
  }

  for (const op of w.ops ?? []) {
    const kind = Object.hasOwn(OP_KINDS, op.name) ? OP_KINDS[op.name] : null;
    stats.ops += 1;
    if (kind === null) {
      stats._uninterpreted.set(op.name, (stats._uninterpreted.get(op.name) ?? 0) + 1);
      stats.opsUninterpretedTotal += 1;
    } else if (kind === 'structural') {
      stats._structural.set(op.name, (stats._structural.get(op.name) ?? 0) + 1);
    }
    const bucket = WRITE_OPS.has(op.name) ? 'writes' : 'reads';

    // A method reference names a PROPERTY of a class, wherever it sits — inside
    // `eq(…)` or inside the lambda an `and(…)` takes. It is read the same way in
    // both, because `SysUserDepart::getDepId` cannot mean anything else. That is
    // why a `structural` op still contributes columns: this lane declines to
    // read the op as a PREDICATE, not to read the getter it names.
    for (const p of op.props ?? []) {
      if (!p.property) continue;
      const ref = { propOwner: p.owner ?? null, property: p.property, op: op.name };
      out[bucket].push(ref);
      if (op.name === 'select') out.selects.push(ref);
    }

    if (kind === 'structural' || kind === null) continue;

    // A STRING LITERAL. For a `QueryWrapper` the string IS the column, as
    // written; for a SQL-fragment op it is a fragment and naming a column from
    // it would be a guess. MP's `(boolean condition, …)` overloads put a boolean
    // in front, so one leading boolean literal is stepped over.
    const args = Array.isArray(op.args) ? op.args : [];
    let i = 0;
    if (typeof args[0] === 'boolean') i = 1;
    if (kind === 'sql') {
      // `inSql(column, sql)` is the one fragment op whose FIRST argument is a
      // column; the rest carry SQL only.
      const fragStart = (op.name === 'inSql' || op.name === 'notInSql') ? i + 1 : i;
      if (fragStart > i && typeof args[i] === 'string') pushLiteral(out, bucket, args[i], op);
      // the fragments themselves are collected once, below, by the SAME
      // enumeration `wrapperFragmentStatements` numbered them with
      continue;
    }
    if (kind === 'columns') {
      for (let j = i; j < args.length; j += 1) {
        if (typeof args[j] === 'string') pushLiteral(out, bucket, args[j], op);
      }
      continue;
    }
    if (typeof args[i] === 'string') pushLiteral(out, bucket, args[i], op);
  }
  // THE RAW SQL FRAGMENTS, numbered the way the synthetic statements were.
  // `<method>#frag<n>` is how the lineage record for this fragment is keyed, so
  // the two enumerations MUST be the same one — hence `wrapperFragments` and
  // `wrapperFragmentBases`, shared with `wrapperFragmentStatements`.
  const method = w.from.slice(w.from.lastIndexOf('#') + 1);
  const base = ctx.fragmentBases?.get(w) ?? 0;
  out.fragments = wrapperFragments(w).map((f, k) => ({
    ...f, index: base + k, statementKey: `${ownerFqn}.${method}#frag${base + k}`,
  }));
  stats.sqlFragments += out.fragments.length;

  if (out.selects.length > 0) stats.wrappersNarrowingSelect += 1;
  if (out.reads.length > 0 || out.writes.length > 0) stats.wrappersWithColumns += 1;
  return out;
}

/**
 * WHICH ENTITY a wrapper filters, in order of decreasing directness: the type
 * argument it was declared with, then the owner of a method reference it uses
 * (`SysUserDepart::getDepId` names the class as plainly as a type argument
 * does). Neither is a guess; both are written in the source. A wrapper built
 * over a type PARAMETER has neither and gets its entity from the statement it
 * is handed to instead.
 */
function wrapperEntity(w, { entities, resolveType }) {
  const ownerFqn = w.from.slice(0, w.from.lastIndexOf('#'));
  if (w.entityTypeSimple) {
    const f = resolveType(ownerFqn, w.entityTypeSimple);
    if (f && entities.has(f)) return { entity: f, from: 'type-argument' };
  }
  for (const op of w.ops ?? []) {
    for (const p of op.props ?? []) {
      const f = p.owner ? resolveType(ownerFqn, p.owner) : null;
      if (f && entities.has(f)) return { entity: f, from: 'method-reference' };
    }
  }
  return { entity: null, from: null };
}

/**
 * A string literal a `QueryWrapper` op names: a PHYSICAL column name as written
 * — that is what MyBatis-Plus passes through to the SQL. An argument that is not
 * a bare identifier is not read as one, and says so.
 */
function pushLiteral(out, bucket, literal, op) {
  const name = String(literal).trim();
  if (name.length === 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    out.unresolved.push({ reason: 'wrapper-literal-not-a-column', detail: `${op.name}(${JSON.stringify(literal)}): the argument is not a bare identifier, so it is not read as a column name` });
    return;
  }
  const ref = { literal: name, op: op.name };
  out[bucket].push(ref);
  if (op.name === 'select') out.selects.push(ref);
}

/**
 * The columns one wrapper reference names, resolved against the entity model —
 * the wrapper's OWN entity when it has one, otherwise the entity of the
 * statement the wrapper was handed to (which is how a wrapper built over a type
 * PARAMETER gets a column at all).
 */
function columnsOf(refs, w, fallbackEntity, ctx, sink) {
  const { entities, resolveType, stats } = ctx;
  const out = [];
  const home = (w.entity ? entities.get(w.entity) : null) ?? fallbackEntity ?? null;
  for (const ref of refs) {
    if (ref.literal) {
      if (!home) {
        sink.push({ reason: 'wrapper-entity-unknown', detail: `${ref.op}(${JSON.stringify(ref.literal)}) names a column, but which table this wrapper filters is not known here` });
        continue;
      }
      out.push({ entity: home, table: home.table, column: ref.literal, grade: home.tableGrade, via: `wrapper-op:${ref.op}`, role: 'predicate', fromLiteral: true });
      stats.columnsFromLiteral += 1;
      continue;
    }
    const ownerFqn = ref.propOwner ? resolveType(w.ownerFqn, ref.propOwner) : null;
    const owner = (ownerFqn ? entities.get(ownerFqn) : null) ?? home;
    if (!owner) {
      sink.push({ reason: 'wrapper-property-owner-unknown', detail: `${ref.propOwner ?? '?'}::${ref.property} names a class this pack does not map to a table` });
      continue;
    }
    const field = owner.fields.get(ref.property);
    if (!field || !field.column) {
      sink.push({ reason: 'wrapper-property-has-no-column', detail: `${owner.fqn}.${ref.property} owns no column (${field ? (field.reason ?? 'not mapped') : 'no such field'})` });
      continue;
    }
    out.push({ entity: owner, table: owner.table, column: field.column, grade: weakest(owner.tableGrade, field.grade), via: `wrapper-op:${ref.op}`, role: 'predicate' });
    stats.columnsFromMethodReference += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// raw SQL fragments inside a wrapper
// ---------------------------------------------------------------------------
//
// `apply / last / setSql / inSql / notInSql / exists / notExists / having` hand
// MyBatis-Plus a piece of SQL TEXT. Until RM17 this lane could only say so and
// stop: the statement carried an `unresolved` note and whatever column the
// fragment named was missing from the column list — silently, from the reader's
// point of view, because the note is not a column edge.
//
// A fragment is SQL, so it goes where SQL goes: the SAME lineage.py, catalog,
// dialect, identifier rule and content-addressed shard cache as a mapper
// statement or a native `@Query`. It is not a whole statement, though, so the
// op says how to write it into one — `apply(cond)` is a WHERE, `setSql(x)` is an
// UPDATE ... SET, `last("limit 10")` is a tail. The FROM is the table the
// wrapper filters, which is why this needs the entity model and not just the
// fact stream. Nothing else is added: if the result does not parse, the
// statement keeps the old `unresolved` note WITH the text (§3.3 — nothing is
// invented).

/** How each fragment op is written into a statement the SQL analyzer can read. */
const FRAGMENT_STATEMENT = Object.freeze({
  apply: (t, f) => `SELECT 1 FROM ${t} WHERE (${f.sql})`,
  having: (t, f) => `SELECT 1 FROM ${t} HAVING (${f.sql})`,
  exists: (t, f) => `SELECT 1 FROM ${t} WHERE EXISTS (${f.sql})`,
  notExists: (t, f) => `SELECT 1 FROM ${t} WHERE NOT EXISTS (${f.sql})`,
  inSql: (t, f) => (f.column ? `SELECT 1 FROM ${t} WHERE ${f.column} IN (${f.sql})` : null),
  notInSql: (t, f) => (f.column ? `SELECT 1 FROM ${t} WHERE ${f.column} NOT IN (${f.sql})` : null),
  // `last` appends to the end of the generated query — `limit 10`, `for update`.
  last: (t, f) => `SELECT 1 FROM ${t} ${f.sql}`,
  setSql: (t, f) => `UPDATE ${t} SET ${f.sql}`,
});

/** The statement type each op produces — `setSql` writes, everything else reads. */
const FRAGMENT_TYPE = Object.freeze({ setSql: 'update' });

/** A bare column name, the only thing `inSql(column, sql)` can be given. */
const BARE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * MyBatis-Plus's own placeholder — `apply("create_time > {0}", d)` binds `{0}`
 * to the first value — replaced by the `?` a SQL parser accepts. Exactly what
 * `normalizeBindParameters` does for JPA's `?1` / `:name`, and for the same
 * reason: without it every parameterised fragment would come back parse_failed.
 * Text inside a string literal is stepped over, so `'{0}'` stays as written.
 * @param {string} sql
 * @returns {string}
 */
export function normalizeMpPlaceholders(sql) {
  const s = String(sql ?? '');
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < s.length) {
        if (s[j] === '\\') { j += 2; continue; }
        if (s[j] === c) { j += 1; break; }
        j += 1;
      }
      out += s.slice(i, j);
      i = j;
      continue;
    }
    if (c === '{') {
      const m = /^\{\d+\}/.exec(s.slice(i));
      if (m) { out += '?'; i += m[0].length; continue; }
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * Every raw SQL fragment ONE wrapper record carries, in op order.
 * `inSql(column, sql)` / `notInSql` are the two ops whose first argument is a
 * column rather than SQL; it is carried on the fragment because the statement
 * this fragment becomes needs it (`WHERE <column> IN (<sql>)`).
 * @param {object} w  an `mpWrapper` record
 * @returns {{op:string, sql:string, line:(number|null), column:(string|null)}[]}
 */
export function wrapperFragments(w) {
  const out = [];
  for (const op of (w && w.ops) ?? []) {
    if (!Object.hasOwn(OP_KINDS, op.name) || OP_KINDS[op.name] !== 'sql') continue;
    const args = Array.isArray(op.args) ? op.args : [];
    // MP's `(boolean condition, …)` overloads put a boolean in front.
    const i = typeof args[0] === 'boolean' ? 1 : 0;
    const takesColumn = op.name === 'inSql' || op.name === 'notInSql';
    const raw = takesColumn && typeof args[i] === 'string' ? String(args[i]).trim() : null;
    const column = raw && BARE_IDENTIFIER.test(raw) ? raw : null;
    for (let j = takesColumn ? i + 1 : i; j < args.length; j += 1) {
      if (typeof args[j] !== 'string') continue;
      out.push({ op: op.name, sql: args[j], line: op.line ?? null, column });
    }
  }
  return out;
}

/**
 * The first fragment number each wrapper record owns, so that a method building
 * TWO wrappers still numbers its fragments `frag0, frag1, …` once, without a
 * gap and without a collision.
 *
 * INGEST ORDER MUST NOT DECIDE A NAME. The wrappers of one method are put in a
 * total order derived from what they SAY (line, variable, kind, origin, ops),
 * never from where they landed in the fact stream — a shard splice that
 * reordered two records would otherwise swap two statement ids and silently
 * hand each fragment the other's lineage.
 *
 * @param {object[]} wrapperRecords
 * @returns {Map<object, number>} record -> its first fragment index
 */
export function wrapperFragmentBases(wrapperRecords) {
  const byFrom = new Map();
  for (const w of wrapperRecords ?? []) {
    if (!w || typeof w.from !== 'string') continue;
    const list = byFrom.get(w.from);
    if (list) list.push(w); else byFrom.set(w.from, [w]);
  }
  const bases = new Map();
  for (const list of byFrom.values()) {
    const sorted = [...list].sort((a, b) => cmp(wrapperOrderKey(a), wrapperOrderKey(b)));
    let n = 0;
    for (const w of sorted) {
      bases.set(w, n);
      n += wrapperFragments(w).length;
    }
  }
  return bases;
}

const wrapperOrderKey = (w) => JSON.stringify([
  w.line ?? -1, w.var ?? '', w.wrapperKind ?? '', w.origin ?? '', w.builtBy ?? '', w.ops ?? [],
]);

/**
 * The wrapper SQL fragments of a whole project, in the shape the SQL lane's own
 * statement records have — ready for `lineage.py`.
 *
 * PURE, and separate from `addMybatisPlusFacts` on purpose, exactly like
 * `nativeQueryStatements` on the JPA side: `analyze` calls this BEFORE building
 * the graph, so the fragments arrive as ordinary lineage records built by the
 * same analyzer, against the same catalog, under the same identity rule, out of
 * the same shard cache.
 *
 * A fragment whose wrapper has no entity OF ITS OWN (a `QueryWrapper<T>` in a
 * generic base class: which table it filters is decided by the subclass that
 * binds `T`, per statement) is NOT written out here — there is no single table
 * to put in the FROM, and guessing one would attach a column fact to a table the
 * code never names. Those keep the old `unresolved` note with their text.
 *
 * @param {object[]} javaFacts
 * @param {object} [opts]  the same options `addMybatisPlusFacts` takes
 * @returns {{kind:string, namespace:string, id:string, type:string, sql:string,
 *            file:(string|null), line:(number|null)}[]}
 */
export function wrapperFragmentStatements(javaFacts, opts = {}) {
  const model = readEntityModel(javaFacts, opts);
  if (model.empty) return [];
  const { entities, resolveType, wrapperRecords, schema } = model;
  const bases = wrapperFragmentBases(wrapperRecords);
  const out = [];
  for (const w of wrapperRecords) {
    const frags = wrapperFragments(w);
    if (frags.length === 0) continue;
    const hash = w.from.lastIndexOf('#');
    const ownerFqn = w.from.slice(0, hash);
    const method = w.from.slice(hash + 1);
    const entityFqn = wrapperEntity(w, { entities, resolveType }).entity;
    const e = entityFqn ? entities.get(entityFqn) : null;
    if (!e) continue;
    const from = tableKey(e.schema ?? schema, e.table);
    const base = bases.get(w) ?? 0;
    frags.forEach((f, k) => {
      const write = FRAGMENT_STATEMENT[f.op];
      const sql = write ? write(from, { ...f, sql: normalizeMpPlaceholders(f.sql) }) : null;
      if (!sql || sql.trim().length === 0) return;
      out.push({
        kind: 'statement',
        namespace: ownerFqn,
        id: `${method}#frag${base + k}`,
        type: FRAGMENT_TYPE[f.op] ?? 'select',
        sql,
        file: w.file ?? null,
        line: f.line,
      });
    });
  }
  // Deterministic, and one record per id: two identical wrappers on one method
  // fold onto one fragment statement rather than racing for the same key.
  const seen = new Set();
  return out
    .filter((st) => (seen.has(`${st.namespace}.${st.id}`) ? false : (seen.add(`${st.namespace}.${st.id}`), true)))
    .sort((a, b) => cmp(`${a.namespace}.${a.id}`, `${b.namespace}.${b.id}`));
}

// ---------------------------------------------------------------------------
// statements
// ---------------------------------------------------------------------------

/**
 * The types a call can land on. The three rules are the SAME ones the call lane
 * applies (src/adapters/java_bridge.mjs) — a field receiver through its declared
 * type, an unqualified/`this` call through the enclosing type, and a receiver
 * whose declared type is a TYPE PARAMETER through every binding a subclass
 * makes. `JeecgController<T, S extends IService<T>>.service.list(...)` is the
 * third: one call site, one statement per concrete service a subclass binds.
 */
function callTargets(c, ownerFqn, { types, resolveType, bindingsOf }) {
  if (c.via === 'unqualified' || c.via === 'this-method') {
    return types.has(ownerFqn) ? [ownerFqn] : [];
  }
  if (c.via === 'super-method') return []; // the super call lane resolves it; MP has no such base here
  const tpIndex = (types.get(ownerFqn)?.typeParams ?? []).indexOf(c.toTypeSimple);
  if (tpIndex >= 0 && c.toTypeSimple) {
    const out = new Set();
    for (const b of bindingsOf.get(ownerFqn) ?? []) {
      const argSimple = b.args[tpIndex];
      if (!argSimple) continue;
      const argFqn = resolveType(b.sub, argSimple);
      if (argFqn) out.add(argFqn);
    }
    return [...out].sort(cmp);
  }
  const t = resolveType(ownerFqn, c.toTypeSimple);
  return t ? [t] : [];
}

/**
 * WHICH TYPE OWNS THE STATEMENT. A call through `ISysUserService` runs
 * `SysUserServiceImpl`'s inherited built-in, so the statement belongs to the
 * IMPL — reached from the interface by the dispatch edge the call lane already
 * put there. When nothing in this pack implements the interface (every MyBatis
 * mapper: its implementation is generated at run time) the interface owns it.
 */
function statementOwners(targetFqn, r, { types, implementorsOf, roleOf }) {
  const t = types.get(targetFqn);
  if (!t || t.typeKind !== 'interface') return [targetFqn];
  const impls = [...(implementorsOf.get(targetFqn) ?? new Set())]
    .filter((sub) => {
      const role = roleOf(sub);
      return role && role.role === r.role && types.get(sub)?.typeKind !== 'interface';
    })
    .sort(cmp);
  return impls.length > 0 ? impls : [targetFqn];
}

/** One generic-CRUD statement: what MyBatis-Plus's built-in does to the row. */
function emitBuiltinStatement(g, a) {
  const { stmt, entity, stats, tableIdOf, columnIdOf, ensureColumn, types } = a;
  const fragmentLineage = a.fragmentLineage ?? new Map();
  const sid = nodeId('statement', stmt.key);
  const verb = stmt.verb;
  const reads = [];
  const writes = [];
  const unresolved = [];
  const notes = [];
  let access = 'read';
  let logicDelete = false;

  const mapped = [...entity.fields.values()].filter((f) => f.column);
  const allColumns = mapped.map((f) => ({ table: entity.table, column: f.column, grade: weakest(entity.tableGrade, f.grade), role: 'row' }));
  const idColumns = mapped.filter((f) => f.id === true)
    .map((f) => ({ table: entity.table, column: f.column, grade: weakest(entity.tableGrade, f.grade), role: 'primary-key' }));

  // The wrapper columns every call site that reaches this statement can touch.
  const wrapperReads = [];
  const wrapperWrites = [];
  const selectNarrowing = [];
  const fragmentReads = [];
  const fragmentWrites = [];
  const fragmentTables = [];
  let runtimeOnly = false;
  const runtimeReasons = new Set();
  for (const w of stmt.wrappers) {
    // Resolved HERE, against THIS statement's entity: a wrapper built over a
    // type parameter (`QueryWrapper<T>` in a shared base controller) has no
    // entity of its own, and the subclass binding that produced this statement
    // is exactly what says which table its `in("id")` filters.
    for (const c of columnsOf(w.reads, w, entity, a.resolveCtx, unresolved)) wrapperReads.push(c);
    for (const c of columnsOf(w.writes, w, entity, a.resolveCtx, unresolved)) wrapperWrites.push(c);
    for (const c of columnsOf(w.selects, w, entity, a.resolveCtx, unresolved)) selectNarrowing.push(c);
    for (const u of w.unresolved) unresolved.push(u);
    for (const f of w.fragments) {
      // THE FRAGMENT, AS SQL. Its lineage record was produced by lineage.py in
      // the lane phase (`wrapperFragmentStatements` wrote the statement, the CLI
      // ran it). Present and resolved, its tables and columns join this
      // statement's; absent or unparsed, the old note stands — WITH the text,
      // so the reader knows exactly what was not read.
      const rec = fragmentLineage.get(f.statementKey);
      const why = fragmentFailure(rec, f, w);
      if (why) {
        unresolved.push({ reason: 'wrapper-sql-fragment', detail: why });
        stats.fragmentsUnresolved += 1;
        continue;
      }
      stats.fragmentsResolved += 1;
      for (const t of rec.tables ?? []) {
        if (t.table === entity.table && (t.schema ?? null) === (entity.schema ?? null)) continue;
        fragmentTables.push({ table: t.table, schema: t.schema ?? null, access: t.access, op: f.op });
      }
      for (const c of rec.columns ?? []) {
        if (c.access !== 'read' && c.access !== 'write') continue;
        const own = c.table === entity.table && (c.schema ?? null) === (entity.schema ?? null);
        const col = {
          entity: own ? entity : { schema: c.schema ?? null },
          table: c.table, column: c.column,
          // The fragment's TEXT is exact; the FROM this lane wrote around it is
          // only as sure as the entity's table name, so a fragment column on the
          // entity's own table is never surer than that mapping.
          grade: own ? entity.tableGrade : 'EXACT',
          via: `wrapper-fragment:${f.op}`, role: 'sql-fragment', fragmentOp: f.op,
        };
        (c.access === 'write' ? fragmentWrites : fragmentReads).push(col);
        stats.fragmentColumns += 1;
      }
    }
    if (w.runtimeOnly) { runtimeOnly = true; if (w.runtimeReason) runtimeReasons.add(w.runtimeReason); }
  }
  if (stmt.noWrapperCall && VERB_TAKES_WRAPPER.has(verb)) {
    runtimeOnly = runtimeOnly || false; // a call with no wrapper is not a mystery — see below
  }

  if (verb === 'insert') {
    access = 'write';
    notes.push('MyBatis-Plus writes the NON-NULL fields of the entity; statically every mapped column is a candidate');
    writes.push(...allColumns);
  } else if (verb === 'save-or-update') {
    access = 'write';
    notes.push('saveOrUpdate inserts or updates by the id, so it both reads the key and writes every mapped column');
    writes.push(...allColumns);
    reads.push(...idColumns);
  } else if (verb === 'updateById') {
    access = 'write';
    notes.push('an update by id writes the non-null fields and reads the key; statically every mapped non-id column is a write candidate');
    writes.push(...allColumns.filter((c) => !idColumns.some((k) => k.column === c.column)));
    reads.push(...idColumns);
  } else if (verb === 'update') {
    access = 'write';
    if (wrapperWrites.length > 0) {
      notes.push('the UpdateWrapper names the columns it sets');
      writes.push(...wrapperWrites);
    } else {
      notes.push('no UpdateWrapper `set(...)` is visible here, so every mapped column is a write candidate');
      writes.push(...allColumns);
    }
    reads.push(...wrapperReads);
  } else if (verb === 'deleteById' || verb === 'delete' || verb === 'selectById' || verb === 'select') {
    const deleting = verb === 'deleteById' || verb === 'delete';
    if (deleting && entity.logicColumn) {
      // LOGICAL DELETE. `@TableLogic` turns MyBatis-Plus's DELETE into an UPDATE
      // that sets the flag column — the row stays, so calling this a delete would
      // be wrong about what the statement does and about which column it touches.
      access = 'write';
      logicDelete = true;
      stats.logicDeleteRewrites += 1;
      const v = a.logicDeleteValue;
      notes.push(`@TableLogic on ${entity.fqn}: MyBatis-Plus rewrites this delete into an UPDATE that sets ${entity.logicColumn.column}`
        + (v ? ` to ${v}` : ' to the deleted value (the profile declares none, so it is not named here)'));
      writes.push({ table: entity.table, column: entity.logicColumn.column, grade: weakest(entity.tableGrade, entity.logicColumn.grade), role: 'logic-delete' });
    } else if (deleting) {
      access = 'delete';
      notes.push('the row is removed; its columns are not individually written');
    }
    if (verb === 'deleteById' || verb === 'selectById') {
      reads.push(...idColumns);
      if (idColumns.length === 0) {
        unresolved.push({ reason: 'mp-no-table-id', detail: `${entity.fqn} declares no @TableId, so the by-id ${deleting ? 'delete' : 'lookup'} names no key column` });
      }
    }
    reads.push(...wrapperReads);
    if (verb === 'select') {
      // What the SELECT actually projects. MyBatis-Plus selects EVERY mapped
      // column into the entity unless the wrapper's `select(...)` narrows it, so
      // the projection is part of what the statement reads — leaving it out
      // would report a read that happens as one that does not.
      if (selectNarrowing.length > 0) {
        notes.push('the wrapper\'s select(...) narrows the projection to the columns it names');
        reads.push(...selectNarrowing.map((c) => ({ ...c, role: 'projection' })));
      } else {
        reads.push(...allColumns.map((c) => ({ ...c, role: 'projection' })));
      }
    }
  }

  // THE FRAGMENT'S OWN COLUMNS. Folded in after the verb decided what the
  // statement does, because a fragment names columns whatever the verb is: an
  // `apply(...)` on a select is a filter, on an update it is still a filter, and
  // a `setSql(...)` is the update's own SET.
  reads.push(...fragmentReads);
  if (access === 'delete' && fragmentWrites.length > 0) {
    // I-2: a DELETE writes no column. A fragment that parsed as a write on a
    // deleting statement is reported rather than turned into a column write.
    unresolved.push({
      reason: 'wrapper-fragment-write-on-delete',
      detail: `${[...new Set(fragmentWrites.map((c) => c.fragmentOp))].sort().join(', ')} read as writing `
        + `${[...new Set(fragmentWrites.map((c) => `${c.table}.${c.column}`))].sort().join(', ')}, but this statement deletes rows. A delete writes no column, so the fragment's writes are NOT in this statement's column list`,
    });
  } else {
    writes.push(...fragmentWrites);
  }

  // A @TableLogic entity has `<logic column> = <not-deleted>` appended to EVERY
  // generated query — that is a read of the column nobody wrote down.
  if (entity.logicColumn && (access === 'read' || logicDelete || verb === 'update')) {
    reads.push({
      table: entity.table, column: entity.logicColumn.column,
      grade: weakest(entity.tableGrade, entity.logicColumn.grade),
      role: 'implicit-logic-filter',
    });
    stats.implicitLogicFilters += 1;
  }

  if (runtimeOnly) {
    stats.statementsRuntimeOnlyColumns += 1;
    unresolved.push({
      reason: 'wrapper-columns-runtime-only',
      detail: [...runtimeReasons].sort().join(' | ') || 'a wrapper reaching this statement was built outside this method',
    });
  }

  const node = {
    id: sid,
    statementType: 'mp-builtin',
    source: 'mybatis-plus',
    file: types.get(stmt.ownerFqn)?.file ?? null,
    line: null,
    mpEvidence: {
      owner: stmt.ownerFqn, method: stmt.method, verb, entity: entity.fqn,
      table: entity.table, tableGrade: entity.tableGrade, tableEvidence: entity.tableEvidence,
      access, note: notes.join('; ') || null,
      ...(logicDelete ? { logicDelete: true } : {}),
      callers: [...new Set(stmt.callers)].sort(cmp).slice(0, 20),
      callerCount: new Set(stmt.callers).size,
    },
  };
  if (runtimeOnly) {
    // The whole point of the RUNTIME_ONLY grade: the table is known, the columns
    // are not, and BOTH are said out loud rather than one of them going quiet.
    node.columnsRuntimeOnly = true;
    node.columnsRuntimeOnlyReason = [...runtimeReasons].sort().join(' | ');
  }
  if (unresolved.length > 0) {
    node.hasUnresolved = true;
    node.unresolved = unresolved.map((u) => ({ reason: u.reason, detail: u.detail ?? null }));
  }

  // A NAME CLASH with a statement the SQL lane already owns is impossible in a
  // correct project (MyBatis-Plus refuses to register a mapper XML statement
  // whose id is one of BaseMapper's), but "impossible" is not a reason to
  // overwrite somebody's SQL: the existing node wins and the clash is reported.
  const existing = g.nodes.get(sid);
  if (existing && existing.statementType && existing.statementType !== 'mp-builtin') {
    stats.statementIdClashes += 1;
    note(stats, 'mp-statement-id-clash',
      `${stmt.key} is already a ${existing.statementType} statement in this pack (mapper XML or a native query), so the MyBatis-Plus built-in was NOT written over it`);
    return;
  }
  g.addNode(node);
  stats.statements += 1;
  stats.statementsByVerb[verb] = (stats.statementsByVerb[verb] ?? 0) + 1;
  for (const u of unresolved) stats.unresolved.push({ statement: stmt.key, reason: u.reason, detail: u.detail ?? null });

  // The mapper-interface rule, unchanged from the MyBatis and JPA lanes: the
  // METHOD *is* the statement MyBatis-Plus generates for it — definitional.
  const member = `${stmt.ownerFqn}#${stmt.method}`;
  const symId = nodeId('symbol', member);
  g.addNode({ id: symId, symbol: member, owner: stmt.ownerFqn, mpBuiltinMethod: true });
  if (!g.outEdges(symId).some((e) => e.type === 'IMPLEMENTS_STMT' && e.to === sid)) {
    g.addEdge({ from: symId, to: sid, type: 'IMPLEMENTS_STMT', grade: 'EXACT' });
    stats.implementsStmt += 1;
  }

  g.addEdge({
    from: sid, to: tableIdOf(entity, entity.table), type: 'EXECUTES', grade: entity.tableGrade,
    evidence: { access, via: 'mybatis-plus', builtin: stmt.method, ...(logicDelete ? { logicDelete: true } : {}) },
  });

  // A fragment can name a table of its OWN — `exists("select 1 from sys_role
  // where ...")`. That table is written in the source, so the edge is EXACT, and
  // leaving it out would hide a table this statement really touches.
  const fragTables = new Map(); // node id -> {access:Set, ops:Set, schema, table}
  for (const t of fragmentTables) {
    const id = tableIdOf({ schema: t.schema }, t.table);
    let m = fragTables.get(id);
    if (!m) { m = { access: new Set(), ops: new Set() }; fragTables.set(id, m); }
    m.access.add(t.access);
    m.ops.add(t.op);
  }
  for (const id of [...fragTables.keys()].sort(cmp)) {
    const m = fragTables.get(id);
    g.addEdge({
      from: sid, to: id, type: 'EXECUTES', grade: 'EXACT',
      evidence: {
        access: [...m.access].sort().join(','), via: 'mybatis-plus-fragment',
        builtin: stmt.method, fragmentOp: [...m.ops].sort().join(','),
      },
    });
  }

  // ONE edge per (access, column) — but a column reached BOTH ways (the `in(…)`
  // predicate on `dep_id` and the projection that also selects it) keeps BOTH
  // roles. Dropping the second would make the evidence say the statement reads
  // that column only as a filter, which is not what the SQL does.
  const merged = new Map(); // "TYPE|columnId" -> {edgeType, cid, grade, roles, vias, flags}
  for (const [bucket, edgeType] of [[reads, 'READS'], [writes, 'WRITES']]) {
    for (const c of bucket) {
      const owner = c.entity ?? entity;
      const cid = columnIdOf(owner, c.table, c.column);
      ensureColumn(owner, c.table, c.column, c.grade);
      const key = `${edgeType}|${cid}`;
      let m = merged.get(key);
      if (!m) {
        m = { edgeType, cid, grade: c.grade, roles: new Set(), vias: new Set(), fragmentOps: new Set(), literal: false };
        merged.set(key, m);
      }
      if (c.fragmentOp) m.fragmentOps.add(c.fragmentOp);
      // WEAKEST link: the same column reached by a declared name and by a
      // derived one is only as sure as the weaker of the two.
      m.grade = weakest(m.grade, c.grade);
      if (c.role) m.roles.add(c.role);
      m.vias.add(c.via ?? 'mybatis-plus');
      if (c.fromLiteral) m.literal = true;
    }
  }
  for (const key of [...merged.keys()].sort(cmp)) {
    const m = merged.get(key);
    const roles = [...m.roles].sort();
    g.addEdge({
      from: sid, to: m.cid, type: m.edgeType, grade: m.grade,
      evidence: {
        via: [...m.vias].sort().join(','), roles,
        ...(m.fragmentOps.size > 0 ? { fragmentOp: [...m.fragmentOps].sort().join(',') } : {}),
        ...(m.literal ? { literal: true, catalogMatch: g.nodes.get(m.cid)?.stub !== true } : {}),
        ...(m.roles.has('implicit-logic-filter') ? { implicitFilter: true } : {}),
        ...(m.roles.has('logic-delete') ? { logicDelete: true } : {}),
      },
    });
    if (m.edgeType === 'READS') stats.reads += 1; else stats.writes += 1;
  }
}

/**
 * WHY a fragment produced no fact — or `null` when it produced facts.
 *
 * The four ways it can fail are told apart, because they are four different
 * things for a reader to do about it: the fragment was never written out (its
 * wrapper has no table of its own), the analyzer never ran (no python), the SQL
 * did not parse, or it parsed and named nothing this catalog knows. Every one of
 * them keeps the fragment's TEXT in the message.
 */
function fragmentFailure(rec, f, w) {
  const where = `${f.op}(${JSON.stringify(f.sql)}) at line ${f.line}`;
  if (!rec) {
    if (!w.entity) {
      return `${where}: a raw SQL fragment on a wrapper with no entity of its own `
        + `(${w.kind}<T> in a generic base class), so which table it filters is decided per call site and the fragment was not run through the SQL analyzer. Whatever columns it names are NOT in this statement's column list`;
    }
    return `${where}: a raw SQL fragment the SQL analyzer produced no lineage for `
      + '(the SQL lane did not run, or this lane has no reading for the op). Whatever columns it names are NOT in this statement\'s column list';
  }
  const bad = (rec.unresolved ?? []).filter((u) => u && u.reason === 'parse_failed');
  if (bad.length > 0) {
    return `${where}: the SQL analyzer could not parse it (${bad.map((u) => plain(u.detail)).join('; ')}). Whatever columns it names are NOT in this statement's column list`;
  }
  const cols = (rec.columns ?? []).length;
  const tables = (rec.tables ?? []).length;
  if (cols === 0 && tables <= 1) {
    const why = (rec.unresolved ?? []).map((u) => `${u.reason}: ${plain(u.detail)}`).join('; ');
    return `${where}: the SQL analyzer read it but attached it to no column of this catalog${why ? ` (${why})` : ''}. This statement's column list is unchanged`;
  }
  return null;
}

/**
 * sqlglot underlines the offending token with ANSI escapes. They are terminal
 * control bytes, and this text is stored in the pack and read back by tools and
 * a browser, so the message keeps its words and loses the escapes.
 */
function plain(text) {
  // eslint-disable-next-line no-control-regex
  return String(text ?? '').replace(/\u001b\[[0-9;]*m/g, '');
}

/** The verbs whose column set comes from a wrapper rather than the mapping. */
const VERB_TAKES_WRAPPER = new Set(['select', 'delete', 'update']);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function emptyStats(strategy, declared) {
  return {
    entities: 0, entitiesTableDeclared: 0, entitiesWithoutFields: 0,
    tables: 0, tablesStubbed: 0, tablesInCatalog: 0, tableNameCollisions: 0, columns: 0, columnsStubbed: 0, columnsInCatalog: 0,
    statements: 0, statementsByVerb: {}, implementsStmt: 0, reads: 0, writes: 0,
    builtinsOverridden: 0, statementIdClashes: 0,
    wrappers: 0, wrappersWithColumns: 0, wrappersRuntimeOnly: 0, wrappersWithoutSink: 0,
    wrappersNarrowingSelect: 0,
    ops: 0, opsUninterpretedTotal: 0, opsUninterpreted: {},
    columnsFromMethodReference: 0, columnsFromLiteral: 0,
    sqlFragments: 0, fragmentsUnresolved: 0, fragmentsResolved: 0, fragmentColumns: 0,
    logicDeleteEntities: 0, logicDeleteRewrites: 0, implicitLogicFilters: 0,
    statementsRuntimeOnlyColumns: 0,
    unresolvedStatements: 0, unresolved: [],
    namingStrategy: strategy, namingStrategyDeclared: declared,
    opsStructural: {},
    _uninterpreted: new Map(),
    _structural: new Map(),
  };
}

function note(stats, reason, detail) {
  stats.unresolved.push({ statement: null, reason, detail });
}

export class MpBridgeError extends Error {
  constructor(message) { super(message); this.name = 'MpBridgeError'; }
}
