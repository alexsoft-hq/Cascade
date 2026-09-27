// lane_options.mjs — how the JPA and MyBatis-Plus bridges are run, for `cascade analyze` and the working-tree overlay alike.
//
// The overlay (`cascade impact` on uncommitted edits) rebuilds the graph from
// the pack's facts with the edited files re-read. It used to build it without
// the JPA and MyBatis-Plus bridges, so on a project whose SQL comes from Spring
// Data or MyBatis-Plus generic CRUD an edit that changed nothing but a comment
// reported no statement and no column where the pack reached them (jeepay: 0
// and 0 from the working tree, 7 statements and 3 columns from the pack). Both
// callers now take the lane decision and the options from here, so the two
// graphs are built the same way.

import { runLineageForStatements } from '../core/incremental.mjs';
import { catalogDigestOf } from '../core/facts_store.mjs';
import { workerVersions } from '../core/worker_versions.mjs';
import { wrapperFragmentStatements } from '../adapters/mp_bridge.mjs';

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

/** The JPA bridge's options: the profile's naming strategy, else the one the project's configuration names. */
export function jpaOptions(profile, sqlArgs, jpaNaming) {
  return {
    namingStrategy: jpaNaming ? jpaNaming.strategy : profile.jpa?.namingStrategy ?? null,
    schema: sqlArgs.defaultSchema,
    identifierCase: sqlArgs.identifierCase,
  };
}

/**
 * The SQL lineage of MyBatis-Plus wrapper fragments (`apply`, `last`, `inSql`…),
 * through the same analyzer and the same content-addressed shards as every
 * other statement. A fragment analyzed before is read back from `store`; one
 * that is new is analyzed by `runners.lineage`. The overlay hands in a store
 * that reads the cache and writes nothing to disk, so an uncommitted edit never
 * becomes a cached fact.
 *
 * @returns {{fragments:number, lineageRecords:object[], statementEntries:object}}
 */
export function wrapperFragmentLineageOf({ javaFacts, mpOpts, store, index, catalog, sqlArgs, runners, force, diagnostics }) {
  const fragments = wrapperFragmentStatements(javaFacts, mpOpts);
  if (fragments.length === 0) return { fragments: 0, lineageRecords: [], statementEntries: {} };
  const out = runLineageForStatements({
    store, index, statements: fragments,
    catalogDigest: catalogDigestOf(catalog), catalogRecords: catalog,
    inputs: { dialect: sqlArgs.dialect, identifierCase: sqlArgs.identifierCase, defaultSchema: sqlArgs.defaultSchema },
    run: runners, workerVersion: workerVersions().lineage, force,
    diag: (d) => { diagnostics.push(d); },
  });
  return { fragments: fragments.length, lineageRecords: out.lineageRecords, statementEntries: out.statementEntries };
}
