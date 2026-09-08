// profile.mjs — the reading convention (SPEC §6.2).
//
// A profile declares "how do we read THIS project": build tool, top-level
// package prefixes, SQL schema handling, gateway routes, the screen axis, module
// attribution, framework/model packs, catalog acquisition, calibration mode.
// core takes the profile as a REQUIRED input; no product name or default package
// prefix is ever hardcoded (SPEC §6, MUST NOT).
//
// This module works on an ALREADY-PARSED object. Parsing YAML would require a
// runtime dependency, and core is dependency-free by design (SPEC §4). A thin
// file adapter that parses YAML can be wired later; until then `loadProfile`
// handles `.json` and is honest about the `.yaml` gap rather than failing quietly.
//
// Invariant I-4 (MUST): when `schema.default` is not provided, it stays `null` —
// core never invents a schema name for an unknown schema (§3.3, §6.2). See the
// JSDoc on `normalizeProfile`.

import fs from 'node:fs';
import { IDENTIFIER_CASES, identifierCaseForDialect } from './identifier_case.mjs';

/**
 * Documented profile defaults (SPEC §6.2). Frozen. `normalizeProfile` layers a
 * user object over a deep copy of this — arrays REPLACE, they do not concat.
 */
export const PROFILE_DEFAULTS = deepFreeze({
  build: { tool: null, javaRelease: null, profiles: [] },
  packagePrefixes: [],
  schema: { default: null, propertyNames: [], rewriteLayer: null },
  sqlDialects: {},
  sqlIdentifierCase: null,
  gatewayRoutes: {},
  // `enabled: null` is the THIRD state, and the default: no word from the user,
  // so the switch is decided by what the run READS (src/core/lanes.mjs,
  // `screenAxisOf`). `true` and `false` are the user's word and are obeyed.
  screenAxis: { enabled: null, codeRegex: null, pathRule: null, nameSource: 'none' },
  moduleAttribution: { packageDepth: null, codeLength: null },
  frameworkPacks: [],
  modelPacks: [],
  jpa: { namingStrategy: null },
  mybatisPlus: {
    namingStrategy: null, tablePrefix: null,
    logicDeleteValue: null, logicNotDeleteValue: null,
  },
  generatedSources: { annotations: [], pathGlobs: [] },
  openapi: { documents: [] },
  runtimeEvidence: { har: [], otel: [] },
  catalog: { source: 'none', connectionFrom: null },
  calibration: {
    firstRun: 'bootstrap',
    maxRelativeDrop: 0.05,
    maxRelativeDropOnRepin: 0.25,
    receiptTtlDays: 30,
  },
});

/**
 * What `calibration.firstRun` may say (SPEC §14.3). `bootstrap` exempts the very
 * first analysis of a project from the gate and seals its measurements as the
 * baseline; `require-baseline` refuses to certify anything until a human has
 * sealed one deliberately.
 */
const FIRST_RUN_MODES = Object.freeze(['bootstrap', 'require-baseline']);

const BUILD_TOOLS = Object.freeze(['gradle', 'maven', null]);
const CATALOG_SOURCES = Object.freeze(['jdbc', 'file', 'none']);

/**
 * The framework packs this engine actually has a lane for (SPEC §18.2). Anything
 * else a profile declares is reported as UNSUPPORTED_TECHNOLOGY and skipped —
 * never silently ignored (§7.3).
 */
export const KNOWN_FRAMEWORK_PACKS = Object.freeze(['mybatis-xml', 'spring-mvc', 'jpa', 'mybatis-plus', 'web', 'vue-router', 'react-router']);

/**
 * The physical naming strategies `jpa.namingStrategy` may name (SPEC §18.2).
 * `null` (the default) means the project did not say — the engine then ASSUMES
 * Spring Boot's default and grades every name it derived HEURISTIC, so an
 * assumption can never travel as a confirmed mapping (I-1).
 */
export const JPA_NAMING_STRATEGIES = Object.freeze(['spring-snake-case', 'identity']);

/**
 * The physical naming strategies `mybatisPlus.namingStrategy` may name (SPEC
 * §18.2). MyBatis-Plus spells its own default `map-underscore-to-camel-case:
 * true` / `table-underline: true`, which is `underscore` here; `identity` is the
 * project that turned it off. `null` (the default) means the project did not
 * say — the engine then ASSUMES `underscore` and grades every name it derived
 * HEURISTIC, so an assumption can never travel as a confirmed mapping (I-1).
 */
export const MYBATIS_PLUS_NAMING_STRATEGIES = Object.freeze(['underscore', 'identity']);

/**
 * SQL dialect names a profile may write, mapped to the name the sqlglot-based
 * lane takes. Fail-closed: a name outside this table is an error, not a silent
 * fallback to MySQL (a wrong dialect silently mis-parses every statement).
 */
export const SQL_DIALECT_ALIASES = Object.freeze({
  mysql: 'mysql',
  mariadb: 'mysql',
  postgres: 'postgres',
  postgresql: 'postgres',
  oracle: 'oracle',
  'oracle-11g': 'oracle',
  'oracle-19c': 'oracle',
  // SQLGlot 30.17.0 ships NO hsqldb and no h2 parser — `Dialects` lists 33
  // names and neither is among them. Rather than claim a dialect this engine
  // does not have, both route to SQLGlot's DEFAULT (ANSI) parser, which is the
  // honest description of what runs: standard SQL, no vendor extensions. The
  // identifier rule does NOT come from that fallback — it comes from
  // identifier_case.mjs, which knows hsqldb and h2 fold to UPPER case.
  hsqldb: '',
  h2: '',
});

/** The dialect assumed when `sqlDialects` is empty (announced in a diagnostic). */
export const DEFAULT_SQL_DIALECT = 'mysql';

/**
 * I-5's table, in code: every LEAF key of `PROFILE_DEFAULTS` maps to either
 *
 *   status 'consumed'            — the key changes what the engine does, and
 *                                  `where` names the module that reads it;
 *   status 'recorded-not-acted'  — the key is read, carried into the pack's
 *                                  metadata, and a diagnostic is emitted the
 *                                  moment the user sets a non-default value.
 *
 * There is no third status: a key that is neither is a DEAD key, which I-5
 * forbids, and `test/profile_keys.test.mjs` fails the build on one.
 */
export const PROFILE_KEY_CONSUMERS = deepFreeze({
  'build.tool': {
    status: 'recorded-not-acted', where: null,
    note: 'the Java lane parses sources with the JDK Tree API only, with no Gradle/Maven invocation, so the build tool changes nothing here',
  },
  'build.javaRelease': {
    status: 'recorded-not-acted', where: null,
    note: 'parse-only: the lane does not select a --release, so the declared language level is recorded, not applied',
  },
  'build.profiles': {
    status: 'recorded-not-acted', where: null,
    note: 'parse-only: build profiles select dependencies and resources, neither of which this lane resolves',
  },
  packagePrefixes: {
    status: 'consumed', where: 'src/adapters/java_bridge.mjs',
    note: 'a symbol whose owner package is outside every prefix is marked external:true, and calls to it are counted as externalCalls rather than unresolved',
  },
  'schema.default': {
    status: 'consumed', where: 'src/core/lanes.mjs',
    note: 'routed to lineage.py --default-schema and mybatis_extract.py --default-schema; null keeps the schema unknown (I-4)',
  },
  'schema.propertyNames': {
    status: 'consumed', where: 'src/core/lanes.mjs',
    note: 'routed to mybatis_extract.py --schema-property (repeatable): a ${prop}.table qualifier named here is a schema qualifier, not a raw substitution',
  },
  'schema.rewriteLayer': {
    status: 'recorded-not-acted', where: null,
    note: 'SQL rewrite layers are not modelled by this engine',
  },
  sqlDialects: {
    status: 'consumed', where: 'src/core/lanes.mjs',
    note: 'sqlDialects.main selects lineage.py --dialect; only `main` is routed',
  },
  sqlIdentifierCase: {
    status: 'consumed', where: 'src/core/lanes.mjs',
    note: 'the rule that decides when two spellings of a table/column name the same object: fold-lower / fold-upper / exact, routed to lineage.py --identifier-case and to the SQL bridge\'s node keys. null means the dialect\'s own documented rule (MySQL/Postgres fold to lower, Oracle/HSQLDB/H2 to UPPER). This is never a global policy, because folding when the database does not would merge two different tables',
  },
  gatewayRoutes: {
    status: 'consumed', where: 'src/adapters/web_bridge.mjs',
    note: 'the web bridge applies it as the FIRST prefix rule: a front-end prefix it names is replaced by the back-end prefix before the call is matched, and the edge records prefix.from=declared. A key of "*" applies to every call. Declaring it is how a project stops the bridge guessing a prefix by counting matches. src/adapters/java_bridge.mjs applies the same map to an IMPERATIVE Java HTTP call (a WebClient/RestClient/RestTemplate url), which is the same rewrite from the other side of the wire; the "*" key is a front-end base url and is not applied there, because a Java call writes its url at the call site',
  },
  'screenAxis.enabled': {
    status: 'consumed', where: 'src/adapters/web_bridge.mjs',
    note: 'the GATE on the screen axis, in three states. true builds screens whatever the run reads; false builds none; null (or the key absent, which is the default) decides it from what the run READS - a router pack named in frameworkPacks, or a frontend package this run really reads depending on vue-router or react-router. The third state exists for a frontend checked out BESIDE the backend, which no discovery over the analyzed tree can see. `cascade init` writes true when it finds a router package in the tree and leaves it null otherwise',
  },
  'screenAxis.codeRegex': {
    status: 'consumed', where: 'src/adapters/web_bridge.mjs',
    note: 'the pattern a screen CODE is read out of. It is matched against the route name, then its meta title, then its composed path, and the first hit wins (capture group 1 when the pattern has one, the whole match otherwise). Undeclared leaves every screen code null',
  },
  'screenAxis.pathRule': {
    status: 'consumed', where: 'src/adapters/web_bridge.mjs',
    note: '"last-segment" makes a screen\'s label the last segment of its composed path; anything else, or null, keeps the whole path. The path itself is never changed by this, only the short name a list shows',
  },
  'screenAxis.nameSource': {
    status: 'consumed', where: 'src/adapters/web_bridge.mjs',
    note: '"route-meta" reads a screen title from the route\'s own meta.title; "none" leaves it null; "jsdoc-comment" is REFUSED with a diagnostic, because no lane here reads the comment above a component',
  },
  'moduleAttribution.packageDepth': {
    status: 'consumed', where: 'src/core/walks.mjs',
    note: 'when non-null, an endpoint\'s API group is its handler package truncated to this many segments instead of the first path segment (coupling / map inherit it)',
  },
  'moduleAttribution.codeLength': {
    status: 'consumed', where: 'src/adapters/web_bridge.mjs',
    note: 'how many leading characters of a screen CODE name the group it belongs to. It needs screenAxis.codeRegex to have produced a code; without one a screen is grouped by the first segment of its path instead',
  },
  frameworkPacks: {
    status: 'consumed', where: 'src/core/lanes.mjs',
    note: 'drives lane selection when analyze runs without lane flags: mybatis-xml → the SQL lane, spring-mvc → the Java lane, jpa → the JPA bridge over the Java lane\'s entity/repository facts, web → the frontend fact lane over the roots discovery found. vue-router and react-router name the router declaration packs the web worker reads (adapters/web/packs), and are declared for the record: the worker loads every pack in that directory whichever ones the profile names',
  },
  'jpa.namingStrategy': {
    status: 'consumed', where: 'src/adapters/jpa_bridge.mjs',
    note: 'the rule an entity/attribute name without @Table/@Column is turned into a physical name by; null (undeclared) makes the engine assume Spring Boot\'s CamelCase→snake_case default and grade every derived name HEURISTIC instead of EXACT',
  },
  'mybatisPlus.namingStrategy': {
    status: 'consumed', where: 'src/adapters/mp_bridge.mjs',
    note: 'the rule a MyBatis-Plus entity/field name without @TableName/@TableField is turned into a physical name by; null (undeclared) makes the engine assume MyBatis-Plus\'s own camelCase→under_score default and grade every derived name HEURISTIC instead of EXACT',
  },
  'mybatisPlus.tablePrefix': {
    status: 'consumed', where: 'src/adapters/mp_bridge.mjs',
    note: 'MyBatis-Plus\'s global `table-prefix`: prepended to every table name the naming rule DERIVED (a name @TableName spells out already carries whatever prefix it has)',
  },
  'mybatisPlus.logicDeleteValue': {
    status: 'consumed', where: 'src/adapters/mp_bridge.mjs',
    note: 'the value MyBatis-Plus writes into a @TableLogic column when a delete is rewritten into an update; named in the statement\'s evidence when declared, and left unnamed when not. The column is written either way',
  },
  'mybatisPlus.logicNotDeleteValue': {
    status: 'recorded-not-acted', where: null,
    note: 'the "not deleted" value rides in the implicit filter MyBatis-Plus appends; this lane records that the logic column is READ as a filter, not which value it is compared with, so the declared value changes nothing here',
  },
  'generatedSources.annotations': {
    status: 'consumed', where: 'src/adapters/java_bridge.mjs',
    note: 'a type whose annotations include one of these SIMPLE names (e.g. "Generated" for @Generated / @javax.annotation.Generated) is marked generated:true, and so is every symbol it owns; walks then skip generated→generated edges and say so',
  },
  'generatedSources.pathGlobs': {
    status: 'consumed', where: 'src/adapters/java_bridge.mjs',
    note: 'a type whose source file matches one of these globs (* within a segment, ** across segments, e.g. "mall-mbg/**") is marked generated:true; this is the rule for a generator that leaves NO annotation and no banner, which is the common case (mall\'s MyBatis-generator output carries neither)',
  },
  'openapi.documents': {
    status: 'consumed', where: 'src/adapters/openapi_bridge.mjs',
    note: 'the OpenAPI / Swagger documents this project publishes, manifest-relative, read when `analyze` runs without --openapi. Every (method, path) they declare becomes an endpoint node with the same id the Java lane would give it: a route the code also serves is corroborated (declaredBy on the node), a route nothing serves is added with no handler edge, and both drift lists are on laneStats.openapi',
  },
  'runtimeEvidence.har': {
    status: 'consumed', where: 'src/adapters/har_bridge.mjs',
    note: 'the browser recordings this project keeps, manifest-relative, read when `analyze` runs without --har. Every request in one that matches a route this pack serves becomes a `screen --CALLS_HTTP--> endpoint` edge graded RUNTIME_ONLY, which is below every mode\'s floor: it is SHOWN as `observed` and never walked. Discovery never looks for one, because a recording is something a person makes on purpose',
  },
  'runtimeEvidence.otel': {
    status: 'consumed', where: 'src/adapters/runtime_bridge.mjs',
    note: 'the OpenTelemetry trace exports (OTLP/JSON) this project keeps, manifest-relative, read when `analyze` runs without --otel. A trace says which CONCRETE implementation handled a request and which statement ran, so the dispatch edge the static lane could only grade SOUND_SET gains `observed: true` and a count BESIDE its grade, never above it, and an unobserved candidate is left exactly where it was. A hop the trace saw and no static rule explains becomes a MAY_CALL edge graded RUNTIME_ONLY, which is below every mode\'s floor: shown, never walked. Discovery never looks for one, because a capture is something a person makes on purpose',
  },
  modelPacks: {
    status: 'recorded-not-acted', where: null,
    note: 'taint source/sink packs are not shipped',
  },
  'catalog.source': {
    status: 'consumed', where: 'src/core/lanes.mjs',
    note: 'file → the DDL at catalog.connectionFrom when --ddl is absent; jdbc → the pinned snapshot `cascade catalog fetch` wrote to .cascade/catalog/columns.jsonl (analysis itself never connects to a database), and a successful fetch WRITES this value here itself, so nobody hand-edits the profile to make the snapshot count; none → a partial pack with no catalog axis',
  },
  'catalog.connectionFrom': {
    status: 'consumed', where: 'src/core/lanes.mjs',
    note: 'with catalog.source=file this is the DDL path: a string, or an ARRAY of paths applied IN THE ORDER WRITTEN when the schema is split across files, resolved relative to the manifest directory; with source=jdbc/none it is the connection-info file `cascade catalog discover` found (recorded for the human, never dialled by itself), and a fetch that a --candidate chose writes the candidate path here',
  },
  'calibration.firstRun': {
    status: 'consumed', where: 'src/core/calibration.mjs',
    note: 'with no sealed baseline the gate mode is NO_SEAL: firstRun "bootstrap" makes that verdict BOOTSTRAP (exempt, and this run becomes the baseline), "require-baseline" makes it RED',
  },
  'calibration.maxRelativeDrop': {
    status: 'consumed', where: 'src/core/calibration.mjs',
    note: 'the share of a metric an ENGINE_MOVED / BOTH_MOVED run may lose before the gate goes RED (default 0.05, a 5% relative drop)',
  },
  'calibration.maxRelativeDropOnRepin': {
    status: 'consumed', where: 'src/core/calibration.mjs',
    note: 'the wider budget a REPIN run gets, because a drop there can be the analyzed target shrinking rather than the engine getting worse (default 0.25); every drop is still reported as a warn finding',
  },
  'calibration.receiptTtlDays': {
    status: 'consumed', where: 'src/core/receipt.mjs',
    note: 'how many days a deployment receipt stays valid before `cascade verify` refuses it (default 30)',
  },
});

/**
 * Every leaf key path of a profile-shaped object, dotted, sorted. A leaf is
 * anything that is not a plain object with at least one own key — so `{}`
 * (sqlDialects, gatewayRoutes) is a leaf in its own right, not a vanished node.
 * @param {Object} obj
 * @param {string} [prefix]
 * @returns {string[]}
 */
export function leafKeyPaths(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (isObject(v) && Object.keys(v).length > 0) out.push(...leafKeyPaths(v, key));
    else out.push(key);
  }
  return out.sort();
}

/** Read a dotted key path out of an object; undefined when any step is missing. */
export function readKeyPath(obj, keyPath) {
  let cur = obj;
  for (const seg of keyPath.split('.')) {
    if (!isObject(cur) || !Object.hasOwn(cur, seg)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

/** Whether `value` differs from the documented default at `keyPath`. */
export function isNonDefault(keyPath, value) {
  return !sameValue(readKeyPath(PROFILE_DEFAULTS, keyPath), value);
}

/**
 * The sqlglot dialect the SQL lane must run with. FAIL-CLOSED: an unrecognised
 * name throws rather than falling back to MySQL, because a wrong dialect
 * mis-parses every statement in the project and the result would look fine.
 * @param {Object} profile  a normalized profile
 * @returns {string} a sqlglot dialect name
 */
export function sqlDialectOf(profile) {
  const dialects = (profile && profile.sqlDialects) || {};
  const main = dialects.main;
  if (main == null) return DEFAULT_SQL_DIALECT;
  // `undefined`, not falsy: `hsqldb` maps to the EMPTY string (SQLGlot's default
  // parser), which is a routed dialect and must not be mistaken for an unknown one.
  const mapped = Object.hasOwn(SQL_DIALECT_ALIASES, main) ? SQL_DIALECT_ALIASES[main] : undefined;
  if (mapped === undefined) {
    throw new ProfileError(
      `profile.sqlDialects.main ${JSON.stringify(main)} is not a dialect this engine can route. Accepted values are ${Object.keys(SQL_DIALECT_ALIASES).join(', ')}`,
    );
  }
  return mapped;
}

/**
 * The identifier-identity rule this project's SQL lane must match names with —
 * `sqlIdentifierCase` when the profile declares one, otherwise the DECLARED
 * default of the dialect it names (identifier_case.mjs holds that table and the
 * citation for every row).
 *
 * The rule is asked for by the DIALECT NAME the profile wrote (`hsqldb`,
 * `oracle-19c`), not by the sqlglot dialect it routes to: `hsqldb` routes to
 * sqlglot's ANSI parser, which has no case rule of its own, while HSQLDB itself
 * folds to UPPER case. Reading the name the user declared is what keeps those
 * two apart.
 *
 * @param {Object} profile  a normalized profile
 * @returns {'fold-lower'|'fold-upper'|'exact'}
 */
export function sqlIdentifierCaseOf(profile) {
  const declared = profile ? profile.sqlIdentifierCase : null;
  if (declared != null) {
    if (!IDENTIFIER_CASES.includes(declared)) {
      throw new ProfileError(
        `profile.sqlIdentifierCase ${JSON.stringify(declared)} is not an identity rule this engine can apply. Accepted values are ${IDENTIFIER_CASES.join(', ')} (or null for the dialect's own rule)`,
      );
    }
    return declared;
  }
  const main = (profile && profile.sqlDialects && profile.sqlDialects.main) ?? DEFAULT_SQL_DIALECT;
  return identifierCaseForDialect(main);
}

/**
 * The `trust.knownGaps` entries a profile itself implies, whatever the pack
 * holds.
 *
 * The screen axis is the one entry here, and since RM30 it is a REAL check
 * rather than a standing confession: a project that turns the axis on and gets
 * one has no gap to declare, and only a project that asks for screens and does
 * not get them does. The pack's own declaration decides, so pass `axes` when
 * you have it; without one the profile's own request is all there is to go on.
 *
 * @param {Object} profile  a normalized profile
 * @param {Object|null} [axes]  `pack.meta.axes`, when the caller holds a pack
 * @returns {string[]}
 */
export function trustGapsFor(profile, axes = null) {
  const gaps = [];
  const asked = !!(profile && profile.screenAxis && profile.screenAxis.enabled === true);
  const declared = axes && typeof axes === 'object' && axes.screen && typeof axes.screen.status === 'string'
    ? axes.screen.status : null;
  if (declared !== null) {
    if (declared === 'not-shipped') gaps.push('screen-axis-not-shipped');
  } else if (asked) {
    gaps.push('screen-axis-not-shipped');
  }
  return gaps;
}

/**
 * PURE. Every diagnostic a profile deserves: what is declared but not acted on,
 * what is declared and unsupported, and what the engine assumed because the
 * profile left it open. `analyze` prints these to stderr and stores them in
 * `pack.meta.diagnostics` (metadata — outside the digest).
 *
 * Contract with I-5: for every `recorded-not-acted` key, a non-default value
 * MUST produce a diagnostic whose `key` is that key or one of its prefixes, and
 * a default value MUST produce none. `test/profile_keys.test.mjs` enforces it.
 *
 * @param {Object} profile  a normalized profile
 * @returns {{kind:string, severity:string, key:string, reason:string}[]}
 */
export function profileDiagnostics(profile) {
  if (profile === null || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new ProfileError('profileDiagnostics expects a profile object');
  }
  const out = [];
  const add = (kind, severity, key, reason) => out.push({ kind, severity, key, reason });

  // --- consumed keys that still need something said ------------------------
  if (Array.isArray(profile.packagePrefixes) && profile.packagePrefixes.length === 0) {
    add('PROFILE_DEFAULT_ASSUMED', 'info', 'packagePrefixes',
      'packagePrefixes is empty, so every type is treated as project code');
  }

  const dialects = isObject(profile.sqlDialects) ? profile.sqlDialects : {};
  const dialectKeys = Object.keys(dialects);
  if (dialectKeys.length === 0) {
    add('PROFILE_DEFAULT_ASSUMED', 'info', 'sqlDialects',
      `sqlDialects is empty, so the SQL lane assumed the ${DEFAULT_SQL_DIALECT} dialect`);
  } else {
    const extra = dialectKeys.filter((k) => k !== 'main').sort();
    if (extra.length > 0) {
      add('RECORDED_NOT_ACTED', 'warn', 'sqlDialects',
        `only \`main\` is routed; per-statement dialect routing is not shipped (ignored: ${extra.join(', ')})`);
    }
    try {
      sqlDialectOf(profile);
    } catch (e) {
      add('BAD_DIALECT', 'error', 'sqlDialects', e.message);
    }
  }

  // The identity rule is never silent: a run that folds `ITEM` onto `item` — or
  // one that refuses to — must say which rule it used and where the rule came
  // from, because the answer to "is this one table or two?" depends on it.
  if (profile.sqlIdentifierCase == null) {
    const dialectName = (isObject(profile.sqlDialects) && profile.sqlDialects.main) || DEFAULT_SQL_DIALECT;
    add('PROFILE_DEFAULT_ASSUMED', 'info', 'sqlIdentifierCase',
      `sqlIdentifierCase is not declared, so SQL identifiers are matched with the ${dialectName} rule (${identifierCaseForDialect(dialectName)}); set it explicitly to override`);
  } else {
    try {
      sqlIdentifierCaseOf(profile);
    } catch (e) {
      add('BAD_IDENTIFIER_CASE', 'error', 'sqlIdentifierCase', e.message);
    }
  }

  for (const pack of Array.isArray(profile.frameworkPacks) ? profile.frameworkPacks : []) {
    if (!KNOWN_FRAMEWORK_PACKS.includes(pack)) {
      add('UNSUPPORTED_TECHNOLOGY', 'warn', 'frameworkPacks',
        `frameworkPacks declares ${JSON.stringify(pack)}, for which this engine ships no lane, so the pack is skipped (known packs: ${KNOWN_FRAMEWORK_PACKS.join(', ')})`);
    }
  }

  if ((Array.isArray(profile.frameworkPacks) ? profile.frameworkPacks : []).includes('jpa')
      && (!isObject(profile.jpa) || profile.jpa.namingStrategy == null)) {
    add('PROFILE_DEFAULT_ASSUMED', 'info', 'jpa.namingStrategy',
      'jpa.namingStrategy is not declared, so every entity/attribute name the mapping did not spell out with @Table/@Column '
      + 'is derived with Spring Boot\'s default (CamelCase → snake_case) and graded HEURISTIC; declare it to make those mappings EXACT');
  }

  if ((Array.isArray(profile.frameworkPacks) ? profile.frameworkPacks : []).includes('mybatis-plus')
      && (!isObject(profile.mybatisPlus) || profile.mybatisPlus.namingStrategy == null)) {
    add('PROFILE_DEFAULT_ASSUMED', 'info', 'mybatisPlus.namingStrategy',
      'mybatisPlus.namingStrategy is not declared, so every table or column name the mapping did not spell out with @TableName/@TableField '
      + 'is derived with MyBatis-Plus\'s default (camelCase → under_score) and graded HEURISTIC; declare it to make those mappings EXACT');
  }

  if (isObject(profile.mybatisPlus) && profile.mybatisPlus.logicNotDeleteValue != null) {
    add('RECORDED_NOT_ACTED', 'info', 'mybatisPlus.logicNotDeleteValue',
      'mybatisPlus.logicNotDeleteValue is recorded but not acted on. This lane records that a @TableLogic column is read as an implicit filter, not which value the filter compares it with');
  }

  if (isObject(profile.catalog) && profile.catalog.source === 'jdbc') {
    add('SNAPSHOT_REQUIRED', 'info', 'catalog.source',
      'catalog.source is "jdbc": analysis reads the PINNED snapshot at .cascade/catalog/columns.jsonl and never connects to a database. '
      + 'Run `cascade catalog fetch` to write or refresh it');
  }

  // The screen axis needs the web lane: it is built from the router declarations
  // the frontend worker reads, so turning it on with no frontend to read is a
  // declaration that changes nothing, and nothing else would say so.
  if (isObject(profile.screenAxis) && profile.screenAxis.enabled === true
    && !(Array.isArray(profile.frameworkPacks) && profile.frameworkPacks.includes('web'))) {
    add('RECORDED_NOT_ACTED', 'info', 'screenAxis.enabled',
      'screenAxis.enabled is true and frameworkPacks does not declare web, so an unflagged run reads no frontend and builds no screen. Pass --web-src, or add "web" to frameworkPacks');
  }
  if (isObject(profile.screenAxis) && profile.screenAxis.nameSource === 'jsdoc-comment') {
    add('NOT_SHIPPED', 'warn', 'screenAxis.nameSource',
      'screenAxis.nameSource is "jsdoc-comment" and no lane here reads the comment above a component, so every screen title stays null and the screen axis is declared degraded. Use "route-meta" to read the route\'s own meta.title, or "none"');
  }

  // --- recorded-not-acted keys: one diagnostic per non-default value --------
  const buildChanged = ['build.tool', 'build.javaRelease', 'build.profiles']
    .filter((k) => isNonDefault(k, readKeyPath(profile, k)));
  if (buildChanged.length > 0) {
    add('RECORDED_NOT_ACTED', 'info', 'build',
      `this Java lane is parse-only (JDK Tree API, no build invocation), so ${buildChanged.join(', ')} are recorded in the pack metadata and change nothing`);
  }

  if (isObject(profile.schema) && profile.schema.rewriteLayer != null) {
    add('NOT_SHIPPED', 'warn', 'schema.rewriteLayer',
      'SQL rewrite layers are not modelled by this engine');
  }

  // gatewayRoutes is CONSUMED (src/adapters/web_bridge.mjs). What is worth
  // saying out loud is when it is declared and the lane that reads it will not
  // run: the declaration then changes nothing, and nothing else would say so.
  if (isObject(profile.gatewayRoutes) && Object.keys(profile.gatewayRoutes).length > 0
    && !(Array.isArray(profile.frameworkPacks) && profile.frameworkPacks.includes('web'))) {
    add('RECORDED_NOT_ACTED', 'info', 'gatewayRoutes',
      'gatewayRoutes are declared and frameworkPacks does not declare web, so an unflagged run reads no frontend and nothing applies them. Pass --web-src, or add "web" to frameworkPacks');
  }

  // A screen CODE needs a pattern to read it out of. Declaring the length
  // without the pattern leaves every group falling back to the path segment,
  // which is a different grouping, so the mismatch is said out loud.
  if (isObject(profile.moduleAttribution) && profile.moduleAttribution.codeLength != null
    && !(isObject(profile.screenAxis) && typeof profile.screenAxis.codeRegex === 'string' && profile.screenAxis.codeRegex !== '')) {
    add('RECORDED_NOT_ACTED', 'info', 'moduleAttribution.codeLength',
      'moduleAttribution.codeLength says how many characters of a screen CODE name its group, and screenAxis.codeRegex is not declared, so no screen has a code and every screen is grouped by the first segment of its path instead');
  }

  // A recording is read by `analyze`; declaring one with no web lane means the
  // screens it would attach to are never built.
  const har = isObject(profile.runtimeEvidence) && Array.isArray(profile.runtimeEvidence.har)
    ? profile.runtimeEvidence.har : [];
  if (har.length > 0 && !(Array.isArray(profile.frameworkPacks) && profile.frameworkPacks.includes('web'))) {
    add('RECORDED_NOT_ACTED', 'info', 'runtimeEvidence.har',
      `runtimeEvidence.har names ${har.length} recording(s) and frameworkPacks does not declare web, so an unflagged run builds no screen for them to attach to. Pass --web-src, or add "web" to frameworkPacks`);
  }

  if (Array.isArray(profile.modelPacks) && profile.modelPacks.length > 0) {
    add('NOT_SHIPPED', 'warn', 'modelPacks',
      'taint model packs are declared but the taint lane is not shipped');
  }

  if (isObject(profile.calibration) && profile.calibration.firstRun === 'require-baseline') {
    add('GATE_STRICT', 'info', 'calibration.firstRun',
      'calibration.firstRun is "require-baseline": a project with no sealed baseline fails the calibration gate instead of bootstrapping one. Seal the first one with `cascade analyze --accept-baseline`');
  }

  return out;
}

function sameValue(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => sameValue(v, b[i]));
  }
  if (isObject(a) || isObject(b)) {
    if (!isObject(a) || !isObject(b)) return false;
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    return ka.length === kb.length && ka.every((k, i) => k === kb[i] && sameValue(a[k], b[k]));
  }
  return a === b;
}

/**
 * Deep-merge `obj` over `PROFILE_DEFAULTS` and return a frozen normalized profile.
 * Plain objects merge recursively; arrays (and scalars) REPLACE — so, e.g.,
 * `packagePrefixes` given by the user fully replaces the empty default rather
 * than appending to it.
 *
 * Invariant I-4: `schema.default` is left as `null` whenever the caller does not
 * provide it — this function NEVER substitutes a schema name for a missing one.
 *
 * @param {Object} [obj]  a parsed (partial) profile
 * @returns {Readonly<Object>} the frozen normalized profile
 */
export function normalizeProfile(obj = {}) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new ProfileError('normalizeProfile expects a profile object');
  }
  const merged = deepMerge(deepClone(PROFILE_DEFAULTS), obj);
  return deepFreeze(merged);
}

/**
 * Validate a profile object (raw or normalized) and return it unchanged. Throws
 * ProfileError on any breach. Checks apply only to keys that are present, so it
 * is meaningful on a raw partial profile as well as on a normalized one.
 *
 * Breaches (SPEC §6.2):
 *  - `packagePrefixes` present but not an array (MUST be an array — multiple
 *    top-level packages are allowed);
 *  - `schema.default` present, not null, and not a non-empty string;
 *  - `screenAxis.enabled` present and not true, false or null;
 *  - `screenAxis.codeRegex` / `.pathRule` / `.nameSource` present and not a
 *    string or null, or a codeRegex this engine cannot compile;
 *  - `moduleAttribution.codeLength` present and not a positive whole number;
 *  - `runtimeEvidence.har` / `.otel` present and not an array of non-empty paths;
 *  - `catalog.source` present but not in {jdbc, file, none};
 *  - `build.tool` present but not in {gradle, maven, null};
 *  - `generatedSources.annotations` / `.pathGlobs` present but not an array of
 *    non-empty strings.
 *
 * @param {Object} obj
 * @returns {Object} the same object (validated, not normalized)
 */
export function validateProfile(obj) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new ProfileError('validateProfile expects a profile object');
  }

  if ('packagePrefixes' in obj && !Array.isArray(obj.packagePrefixes)) {
    throw new ProfileError('profile.packagePrefixes must be an array (multiple top-level packages allowed)');
  }

  if (isObject(obj.schema) && 'default' in obj.schema) {
    const d = obj.schema.default;
    if (d !== null && !(typeof d === 'string' && d.length > 0)) {
      throw new ProfileError('profile.schema.default must be null or a non-empty string');
    }
  }

  if (isObject(obj.screenAxis) && 'enabled' in obj.screenAxis) {
    // null is a VALUE here, not a missing key: it is the third state, "decide
    // it from what the run reads". Anything but true/false/null is a typo.
    if (obj.screenAxis.enabled !== null && typeof obj.screenAxis.enabled !== 'boolean') {
      throw new ProfileError('profile.screenAxis.enabled must be true, false or null');
    }
  }

  if (isObject(obj.catalog) && 'source' in obj.catalog) {
    if (!CATALOG_SOURCES.includes(obj.catalog.source)) {
      throw new ProfileError(`profile.catalog.source must be one of ${CATALOG_SOURCES.join('|')}, got ${JSON.stringify(obj.catalog.source)}`);
    }
  }

  if (isObject(obj.build) && 'tool' in obj.build) {
    if (!BUILD_TOOLS.includes(obj.build.tool)) {
      throw new ProfileError(`profile.build.tool must be one of gradle|maven|null, got ${JSON.stringify(obj.build.tool)}`);
    }
  }

  if ('sqlIdentifierCase' in obj) {
    const c = obj.sqlIdentifierCase;
    if (c !== null && !IDENTIFIER_CASES.includes(c)) {
      throw new ProfileError(`profile.sqlIdentifierCase must be null or one of ${IDENTIFIER_CASES.join('|')}, got ${JSON.stringify(c)}`);
    }
  }

  if (isObject(obj.jpa) && 'namingStrategy' in obj.jpa) {
    const ns = obj.jpa.namingStrategy;
    if (ns !== null && !JPA_NAMING_STRATEGIES.includes(ns)) {
      throw new ProfileError(`profile.jpa.namingStrategy must be null or one of ${JPA_NAMING_STRATEGIES.join('|')}, got ${JSON.stringify(ns)}`);
    }
  }

  if (isObject(obj.mybatisPlus)) {
    if ('namingStrategy' in obj.mybatisPlus) {
      const ns = obj.mybatisPlus.namingStrategy;
      if (ns !== null && !MYBATIS_PLUS_NAMING_STRATEGIES.includes(ns)) {
        throw new ProfileError(`profile.mybatisPlus.namingStrategy must be null or one of ${MYBATIS_PLUS_NAMING_STRATEGIES.join('|')}, got ${JSON.stringify(ns)}`);
      }
    }
    for (const k of ['tablePrefix', 'logicDeleteValue', 'logicNotDeleteValue']) {
      if (!(k in obj.mybatisPlus)) continue;
      const v = obj.mybatisPlus[k];
      if (v !== null && !(typeof v === 'string' && v.length > 0)) {
        throw new ProfileError(`profile.mybatisPlus.${k} must be null or a non-empty string, got ${JSON.stringify(v)}`);
      }
    }
  }

  if (isObject(obj.openapi) && 'documents' in obj.openapi) {
    const v = obj.openapi.documents;
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || x.length === 0)) {
      throw new ProfileError('profile.openapi.documents must be an array of non-empty paths, relative to the manifest directory');
    }
  }

  for (const k of ['har', 'otel']) {
    if (!isObject(obj.runtimeEvidence) || !(k in obj.runtimeEvidence)) continue;
    const v = obj.runtimeEvidence[k];
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || x.length === 0)) {
      throw new ProfileError(`profile.runtimeEvidence.${k} must be an array of non-empty paths, relative to the manifest directory`);
    }
  }

  if (isObject(obj.screenAxis)) {
    for (const k of ['codeRegex', 'pathRule', 'nameSource']) {
      if (!(k in obj.screenAxis)) continue;
      const v = obj.screenAxis[k];
      if (v !== null && typeof v !== 'string') {
        throw new ProfileError(`profile.screenAxis.${k} must be null or a string`);
      }
    }
    if (typeof obj.screenAxis.codeRegex === 'string' && obj.screenAxis.codeRegex !== '') {
      try {
        // eslint-disable-next-line no-new
        new RegExp(obj.screenAxis.codeRegex);
      } catch (e) {
        throw new ProfileError(`profile.screenAxis.codeRegex is not a regular expression this engine can compile: ${e.message}`);
      }
    }
  }

  if (isObject(obj.moduleAttribution) && 'codeLength' in obj.moduleAttribution) {
    const v = obj.moduleAttribution.codeLength;
    if (v !== null && !(Number.isInteger(v) && v > 0)) {
      throw new ProfileError(`profile.moduleAttribution.codeLength must be null or a positive whole number of characters, got ${JSON.stringify(v)}`);
    }
  }

  if (isObject(obj.generatedSources)) {
    for (const k of ['annotations', 'pathGlobs']) {
      if (!(k in obj.generatedSources)) continue;
      const v = obj.generatedSources[k];
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || x.length === 0)) {
        throw new ProfileError(`profile.generatedSources.${k} must be an array of non-empty strings`);
      }
    }
  }

  if (isObject(obj.calibration)) {
    if ('firstRun' in obj.calibration && !FIRST_RUN_MODES.includes(obj.calibration.firstRun)) {
      throw new ProfileError(`profile.calibration.firstRun must be one of ${FIRST_RUN_MODES.join('|')}, got ${JSON.stringify(obj.calibration.firstRun)}`);
    }
    for (const k of ['maxRelativeDrop', 'maxRelativeDropOnRepin']) {
      if (k in obj.calibration) {
        const v = obj.calibration[k];
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
          throw new ProfileError(`profile.calibration.${k} must be a fraction between 0 and 1 (0.05 = a 5% relative drop), got ${JSON.stringify(v)}`);
        }
      }
    }
    if ('receiptTtlDays' in obj.calibration) {
      const v = obj.calibration.receiptTtlDays;
      if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
        throw new ProfileError(`profile.calibration.receiptTtlDays must be a positive whole number of days, got ${JSON.stringify(v)}`);
      }
    }
  }

  return obj;
}

/**
 * Load a profile from a file. For `.json`, read + parse + normalize + validate and
 * return the normalized profile. For `.yaml`/`.yml`, throw — core is dependency-
 * free and cannot parse YAML here (be honest about the gap, don't fail silently).
 * @param {string} profileFilePath
 * @returns {Readonly<Object>} the frozen normalized profile (for `.json`)
 */
export function loadProfile(profileFilePath) {
  if (typeof profileFilePath !== 'string' || profileFilePath.length === 0) {
    throw new ProfileError('profileFilePath must be a non-empty string');
  }
  const lower = profileFilePath.toLowerCase();
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) {
    throw new ProfileError(
      'YAML profiles require a parser adapter (not yet wired, because core is dependency-free); provide a .json profile or use normalizeProfile(obj) directly.',
    );
  }
  if (!lower.endsWith('.json')) {
    throw new ProfileError(`unsupported profile extension for ${profileFilePath}. Expected .json (or .yaml/.yml once an adapter is wired)`);
  }
  let raw;
  try {
    raw = fs.readFileSync(profileFilePath, 'utf8');
  } catch (e) {
    throw new ProfileError(`cannot read profile at ${profileFilePath}: ${e.message}`);
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    throw new ProfileError(`profile at ${profileFilePath} is not valid JSON: ${e.message}`);
  }
  const normalized = normalizeProfile(obj);
  validateProfile(normalized);
  return normalized;
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Merge `override` onto `base` in place. Plain objects recurse; everything else
// (arrays, scalars, null) replaces. Returns `base`.
function deepMerge(base, override) {
  for (const [k, v] of Object.entries(override)) {
    if (isObject(v) && isObject(base[k])) {
      deepMerge(base[k], v);
    } else if (isObject(v)) {
      base[k] = deepMerge({}, v);
    } else {
      // Arrays replace (not concat), scalars replace, null replaces.
      base[k] = Array.isArray(v) ? v.slice() : v;
    }
  }
  return base;
}

function deepClone(v) {
  if (Array.isArray(v)) return v.map(deepClone);
  if (isObject(v)) {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = deepClone(val);
    return out;
  }
  return v;
}

function deepFreeze(v) {
  if (Array.isArray(v)) {
    for (const item of v) deepFreeze(item);
    return Object.freeze(v);
  }
  if (isObject(v)) {
    for (const val of Object.values(v)) deepFreeze(val);
    return Object.freeze(v);
  }
  return v;
}

export class ProfileError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProfileError';
  }
}
