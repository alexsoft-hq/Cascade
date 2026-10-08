// lane_options.mjs — how the catalog lane and the JPA and MyBatis-Plus bridges are run, for `cascade analyze` and the working-tree overlay alike.
//
// The overlay (`cascade impact` on uncommitted edits) rebuilds the graph from
// the pack's facts with the edited files re-read. It used to build it without
// the JPA and MyBatis-Plus bridges, so on a project whose SQL comes from Spring
// Data or MyBatis-Plus generic CRUD an edit that changed nothing but a comment
// reported no statement and no column where the pack reached them (jeepay: 0
// and 0 from the working tree, 7 statements and 3 columns from the pack). Both
// callers now take the lane decision and the options from here, so the two
// graphs are built the same way.

import { CATALOG_LIVE_WORKER_VERSION } from '../core/worker_versions.mjs';
import { jsonl, parseJsonl } from './env.mjs';

/**
 * THE CATALOG LANE'S INPUTS, for `cascade analyze` and the working-tree overlay
 * alike: the files the catalog comes from, what its cached shard is keyed by,
 * and how its records are read. The overlay used to write its own: it ran the
 * DDL reader with no `--dialect`, so a PostgreSQL migration was read as MySQL
 * (a column typed by an enum fell out), and it handed a pinned snapshot to the
 * DDL reader as if it were DDL, under a key analyze never wrote, so every
 * overlay of such a pack had no tables. Both callers now take this.
 *
 * The dialect is passed whenever it is not MySQL, the reader's own default (the
 * empty one included), so a MySQL project's catalog is computed from the
 * arguments it always was (RM63). A snapshot is read as it is: it IS catalog records, fetched once by
 * `cascade catalog fetch`, and its shard is keyed by the LIVE worker's version
 * too, so a catalog_live.py change cannot be answered from a shard the previous
 * generation produced (SPEC §17.7; src/core/worker_versions.mjs says why this
 * rides in the key's args rather than in the index's worker map).
 *
 * @param {{ddls:{rel:string, abs:string}[], snapshot?:({rel:string, abs:string}|null),
 *          sqlArgs:{dialect:string, database?:string, databaseAssumed?:boolean, identifierCase:string}}} a
 *        the DDL files in the order they are applied; the snapshot only when
 *        there is no DDL, which is when `selectLanes` picks one
 * @returns {{files:{rel:string, abs:string}[], shardArgs:string[], fromSnapshot:boolean,
 *            read:(runpy:(script:string, args:string[])=>string)=>object[]}}
 */
export function catalogLaneInputs({ ddls, snapshot = null, sqlArgs }) {
  return ddls.length === 0 && snapshot ? snapshotCatalog(snapshot) : ddlCatalog(ddls, sqlArgs);
}

/** A pinned snapshot, read as it is: it IS catalog records. */
function snapshotCatalog(snapshot) {
  return {
    files: [snapshot], shardArgs: [`worker=${CATALOG_LIVE_WORKER_VERSION}`, 'source=snapshot'], fromSnapshot: true,
    read: () => jsonl(snapshot.abs),
  };
}

/**
 * The DDL files, read by the catalog worker with the SAME dialect and the SAME
 * identity rule the lineage worker reads statements with (§8.1): the identity rule
 * decides whether `SUPPLIER` and `supplier` in two files are one table. The empty
 * dialect (H2, HSQLDB: sqlglot's standard grammar) is passed as it is; left out,
 * the reader took its own default, MySQL, and read the file with MySQL's grammar
 * and rules. The database the profile names goes with it when it is not the
 * grammar's own, because an ALTER is read by that database's rules. Both are in
 * the shard key, since both change what the reader writes. A database nobody
 * declared is said to be assumed, so the reader says where its rules decide.
 */
function ddlCatalog(ddls, sqlArgs) {
  const { flags, key } = readerFlags(sqlArgs);
  const args = [...flags, '--identifier-case', sqlArgs.identifierCase, ...ddls.map((f) => f.abs)];
  return {
    files: ddls, shardArgs: [`identifier-case=${sqlArgs.identifierCase}`, ...key], fromSnapshot: false,
    read: (runpy) => parseJsonl(runpy('catalog_ddl.py', args)),
  };
}

/** The reader's grammar and database flags, each only when it is not the default, and what each adds to the shard key. */
function readerFlags({ dialect, database = dialect, databaseAssumed = false }) {
  const flags = [];
  const key = [];
  if (dialect != null && dialect !== 'mysql') { flags.push('--dialect', dialect); key.push(`dialect=${dialect}`); }
  if (database !== dialect) { flags.push('--database', database); key.push(`database=${database}`); }
  if (databaseAssumed) { flags.push('--database-assumed'); key.push('database=assumed'); }
  return { flags, key };
}

/**
 * Which of the Java lanes' bridges a run assembles, from the same two witnesses
 * everywhere: the profile names the pack, or the Java lane actually saw an
 * `@Entity` / a repository, or a `@TableName` / MyBatis-Plus mapper or service
 * (a role the rules gave, src/core/java_roles.mjs). A project with none pays nothing.
 *
 * @param {object} profile
 * @param {object[]} javaFacts  the assembled Java records, role records included
 * @param {string[]} javaSrc    the Java source roots the run reads
 */
export function whichJavaLanes(profile, javaFacts, javaSrc) {
  const runJava = javaSrc.length > 0;
  const packs = profile.frameworkPacks ?? [];
  const has = (kinds) => javaFacts.some((r) => r && kinds.includes(r.kind));
  const runJpa = runJava && (packs.includes('jpa') || has(['entity', 'repository']));
  const runMp = runJava && (packs.includes('mybatis-plus') || has(['mpEntity', 'mpMapper', 'mpService']));
  return { runJava, runJpa, runMp };
}

/** The MyBatis-Plus bridge's options: the profile's declarations, and the run's schema and identity rule. */
export function mybatisPlusOptions(profile, sqlArgs) {
  return {
    namingStrategy: profile.mybatisPlus?.namingStrategy ?? null,
    tablePrefix: profile.mybatisPlus?.tablePrefix ?? null,
    logicDeleteValue: profile.mybatisPlus?.logicDeleteValue ?? null,
    logicNotDeleteValue: profile.mybatisPlus?.logicNotDeleteValue ?? null,
    schema: sqlArgs.defaultSchema,
    identifierCase: sqlArgs.identifierCase,
  };
}

/** Only a physical/implicit naming strategy the bridge treats as coming from the configuration (the two states `configReach` weighs against the factory); a profile declaration or nothing at all is not passed through this way. */
const reachable = (naming) => (naming && ['configuration', 'unreadable'].includes(naming.from) ? naming : null);

/**
 * The JPA bridge's options: the profile's two naming strategies (physical and,
 * from RM67-J7, implicit), what the project's configuration names for each
 * (the bridge decides whether either reaches the factory the project builds),
 * and the factory beans and service files the tree's resources declare.
 */
export function jpaOptions(profile, sqlArgs, jpaNaming, jpaImplicitNaming, inputs = {}) {
  return {
    namingStrategy: profile.jpa?.namingStrategy ?? null, configuredNaming: reachable(jpaNaming),
    implicitNamingStrategy: profile.jpa?.implicitNamingStrategy ?? null, configuredImplicitNaming: reachable(jpaImplicitNaming),
    xmlFactories: inputs.xmlFactories ?? [], serviceFiles: inputs.serviceFiles ?? [], resourcesRead: inputs.resourcesRead !== false,
    schema: sqlArgs.defaultSchema, identifierCase: sqlArgs.identifierCase,
  };
}
