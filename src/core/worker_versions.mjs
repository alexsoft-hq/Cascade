// worker_versions.mjs — the version string each lane worker stamps on its output.
//
// WHY A MIRROR AND NOT A PROBE: every content-addressed fact shard folds the
// producing worker's version into its key (SPEC §17.7), so the engine must know
// those versions BEFORE it decides what to recompute — i.e. without paying a JVM
// start and two Python starts just to read three header records. So the constants
// live in the workers (the single source of truth for what they emit) and are
// MIRRORED here.
//
// A mirror can drift, so it is not left to discipline: `test/worker_versions.test.mjs`
// reads the worker sources and fails if any constant here disagrees with the one
// in the file. Bump the worker's constant when its output changes; the test then
// tells you to bump this one.

/** JavaFacts.java — `static final String VERSION`. */
export const JAVA_WORKER_VERSION = 'javafacts/12';
/** mybatis_extract.py — `EXTRACTOR_VERSION`. */
export const MYBATIS_WORKER_VERSION = 'mybatis-extract/2';
/** lineage.py — `LINEAGE_VERSION`. */
export const LINEAGE_WORKER_VERSION = 'lineage/2';
/** catalog_ddl.py — `CATALOG_VERSION`. */
export const CATALOG_WORKER_VERSION = 'catalog-ddl/3';
/**
 * catalog_live.py — `CATALOG_VERSION` (SPEC §12, §15 M5).
 *
 * NOT part of `workerVersions()`, deliberately. A live catalog does not run in
 * an analysis at all: `cascade catalog fetch` writes a SNAPSHOT, and `analyze`
 * only reads that file (§2.3 — the extraction path never connects). So the
 * version does not belong in the facts index's `workers` map, where a change
 * forces a whole cold run for every project; it rides in the catalog shard's
 * `args` instead (bin/cascade.mjs), which invalidates exactly the snapshot-fed
 * catalog shard and nothing else. It is mirrored HERE anyway, and drift-tested
 * the same way, because the same reason applies: shards from two generations of
 * the worker must not share one key.
 */
export const CATALOG_LIVE_WORKER_VERSION = 'catalog-live/1';
/** adapters/web/webfacts.mjs — `const VERSION`. */
export const WEB_WORKER_VERSION = 'webfacts/9';

/**
 * The versions as the facts index records them. One object, so a new worker can
 * only be added in one place.
 * @returns {{java:string, mybatis:string, lineage:string, catalog:string, web:string}}
 */
export function workerVersions() {
  return {
    java: JAVA_WORKER_VERSION,
    mybatis: MYBATIS_WORKER_VERSION,
    lineage: LINEAGE_WORKER_VERSION,
    catalog: CATALOG_WORKER_VERSION,
    web: WEB_WORKER_VERSION,
  };
}

/**
 * Where each mirrored constant is declared, for the drift test: the worker file
 * (engine-root-relative) and the regex that must capture the same string.
 */
export const WORKER_VERSION_SOURCES = Object.freeze([
  { name: 'java', file: 'adapters/java/JavaFacts.java', re: /static\s+final\s+String\s+VERSION\s*=\s*"([^"]+)"/, expected: JAVA_WORKER_VERSION },
  { name: 'mybatis', file: 'adapters/sql/mybatis_extract.py', re: /^EXTRACTOR_VERSION\s*=\s*"([^"]+)"/m, expected: MYBATIS_WORKER_VERSION },
  { name: 'lineage', file: 'adapters/sql/lineage.py', re: /^LINEAGE_VERSION\s*=\s*"([^"]+)"/m, expected: LINEAGE_WORKER_VERSION },
  { name: 'catalog', file: 'adapters/sql/catalog_ddl.py', re: /^CATALOG_VERSION\s*=\s*"([^"]+)"/m, expected: CATALOG_WORKER_VERSION },
  { name: 'catalog-live', file: 'adapters/sql/catalog_live.py', re: /^CATALOG_VERSION\s*=\s*"([^"]+)"/m, expected: CATALOG_LIVE_WORKER_VERSION },
  { name: 'web', file: 'adapters/web/webfacts.mjs', re: /^const VERSION = '([^']+)'/m, expected: WEB_WORKER_VERSION },
]);
