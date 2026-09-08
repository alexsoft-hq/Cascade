// facts_store.mjs — the content-addressed fact SHARD store (SPEC §5.1, §11.2).
//
// The incremental core rests on one idea: a lane's facts are cut into shards
// whose NAME is derived from everything that could change them. Then "is this
// still valid?" is a name lookup, never a judgement call.
//
//   javafacts   one shard per Java source file.  key = sha256(file bytes)
//               + the JavaFacts worker version + the file's --root-relative path.
//               WHY PER FILE: JavaFacts is file-local — it emits types, imports
//               (including wildcard packages), fields, methods, endpoints and
//               calls for the file in front of it and resolves NOTHING across
//               files; every cross-file resolution (simple name -> FQN,
//               interface -> impl dispatch, method -> statement) happens later,
//               in src/adapters/java_bridge.mjs, over the whole fact set. So one
//               edited file invalidates exactly one shard. (Measured: see the
//               metamorphic oracle in test/incremental.test.mjs, which mutates a
//               random subset of files and compares against a cold run.)
//   sqlstmts    ONE shard for the whole mapper set. key = sha256 over every
//               mapper XML's bytes in path order + the extractor version + the
//               profile-derived CLI args. WHY NOT PER FILE: mybatis_extract.py
//               resolves `<include refid>` through a GLOBAL fragment index, so a
//               statement's SQL can come from another file; per-file shards would
//               be a lie. It is cheap to recompute, so it is not split.
//   lineage     one shard PER STATEMENT. key = sha256(sql + statement type +
//               catalog digest + dialect + default schema + lineage version) —
//               exactly what lineage.py reads. The shard holds ONLY the analysis
//               (tables/columns/joins/unresolved); namespace, id, file and line
//               are carried from the statement record at assembly time, because
//               two different statements with identical SQL legitimately share
//               one shard.
//   webfacts    one shard per frontend source file. key = sha256(file bytes)
//               + the webfacts worker version + the file's --root-relative path.
//               WHY PER FILE: adapters/web/webfacts.mjs resolves nothing across
//               files either — it records what each file imports, exports, binds
//               and calls, and src/adapters/web_bridge.mjs is what walks a
//               wrapper to its client and matches a URL against a route, over
//               the whole assembled set. WHAT IS NOT SHARDED: the PACKAGE CONFIG
//               records (`.env*`, the dev-server proxy, the path aliases). They
//               describe a package, not a file under it, and they are cheap, so
//               every run reads them fresh (see `--configs-only` in the worker).
//   catalog     one shard per DDL input. key = sha256(ddl bytes) + parser version
//               + args.
//
// Everything here is PURE over an injected `{readFile, writeFile, exists, mkdir}`.
// The single filesystem-backed adapter is `nodeFactsIo`, kept obviously apart at
// the bottom of the file.

import { canonicalJson, sha256, digest12 } from './canonical.mjs';
import { casDir } from './paths.mjs';

export const FACTS_INDEX_SCHEMA = 'cascade:facts-index:1';

/** The shard kinds this store knows. A shard file is always `<dir>/facts.jsonl`. */
export const SHARD_KINDS = Object.freeze(['javafacts', 'webfacts', 'sqlstmts', 'lineage', 'catalog']);

/** The file inside a shard directory that holds the records. */
export const SHARD_FILE = 'facts.jsonl';

// ---------------------------------------------------------------------------
// Keys (pure)
// ---------------------------------------------------------------------------

/**
 * Shard key for one Java source file.
 * The PATH is part of the key on purpose: JavaFacts stamps the --root-relative
 * path onto every record it emits, so two byte-identical files at two paths are
 * NOT interchangeable facts.
 * @param {{path:string, contentSha256:string, workerVersion:string}} input
 * @returns {string} 12-char hex
 */
export function javaShardKey({ path, contentSha256, workerVersion }) {
  requireString('path', path);
  requireString('contentSha256', contentSha256);
  requireString('workerVersion', workerVersion);
  return digest12({ kind: 'javafacts', path, content: contentSha256, worker: workerVersion });
}

/**
 * Shard key for one frontend source file.
 * The PATH is in the key for the same reason it is in `javaShardKey`: the web
 * worker stamps the --root-relative path onto every record it emits, and the
 * bridge resolves an import by that path, so two byte-identical files at two
 * paths are NOT interchangeable facts.
 * @param {{path:string, contentSha256:string, workerVersion:string}} input
 * @returns {string} 12-char hex
 */
export function webShardKey({ path, contentSha256, workerVersion }) {
  requireString('path', path);
  requireString('contentSha256', contentSha256);
  requireString('workerVersion', workerVersion);
  return digest12({ kind: 'webfacts', path, content: contentSha256, worker: workerVersion });
}

/**
 * Shard key for the whole mapper statement set.
 * @param {{files:{path:string, contentSha256:string}[], workerVersion:string, args:string[]}} input
 * @returns {string} 12-char hex
 */
export function sqlStmtsShardKey({ files, workerVersion, args }) {
  if (!Array.isArray(files)) throw new FactsStoreError('files must be an array');
  requireString('workerVersion', workerVersion);
  const ordered = files
    .map((f) => {
      requireString('files[].path', f && f.path);
      requireString('files[].contentSha256', f && f.contentSha256);
      return [f.path, f.contentSha256];
    })
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return digest12({ kind: 'sqlstmts', files: ordered, worker: workerVersion, args: args ?? [] });
}

/**
 * Shard key for the lineage of ONE statement. Every input lineage.py reads is in
 * here; nothing else can change its output — which is why `identifierCase` is a
 * key part and not a detail: the SAME sql, catalog, dialect and worker resolve
 * to DIFFERENT facts under a different identity rule.
 * @param {{sql:string, statementType:string, catalogDigest:string, dialect:string,
 *          identifierCase:(string|null), defaultSchema:(string|null),
 *          workerVersion:string}} input
 * @returns {string} 12-char hex
 */
export function lineageShardKey({
  sql, statementType, catalogDigest, dialect, identifierCase = null, defaultSchema, workerVersion,
}) {
  // An EMPTY sql string is a legitimate statement (an empty <select/>), so this
  // one is typed, not required non-empty. So is an empty DIALECT: it is how a
  // project asks for sqlglot's default (ANSI) parser, which is what `hsqldb`
  // and `h2` route to (src/core/profile.mjs).
  if (typeof sql !== 'string') throw new FactsStoreError('sql must be a string');
  if (typeof dialect !== 'string') throw new FactsStoreError('dialect must be a string');
  requireString('catalogDigest', catalogDigest);
  requireString('workerVersion', workerVersion);
  return digest12({
    kind: 'lineage',
    sql,
    statementType: statementType ?? null,
    catalog: catalogDigest,
    dialect,
    identifierCase: identifierCase ?? null,
    defaultSchema: defaultSchema ?? null,
    worker: workerVersion,
  });
}

/**
 * Shard key for a parsed DDL catalog — over the WHOLE FILE SET, IN ORDER.
 *
 * A catalog can come from several files (a schema per service, or a base plus a
 * migration sequence), and the fold is order-dependent: `ALTER TABLE … DROP
 * COLUMN` before the `CREATE TABLE` is a different catalog from the same two
 * statements the other way round. So the key covers every file's path and
 * content in the order they are applied — a reordering, an added file or a
 * removed one all produce a different key, which is what stops a shard from one
 * file set answering for another.
 *
 * @param {{files:{path:string, contentSha256:string}[], workerVersion:string, args:string[]}} input
 * @returns {string} 12-char hex
 */
export function catalogShardKey({ files, workerVersion, args }) {
  if (!Array.isArray(files) || files.length === 0) throw new FactsStoreError('files must be a non-empty array');
  for (const f of files) {
    requireString('path', f?.path);
    requireString('contentSha256', f?.contentSha256);
  }
  requireString('workerVersion', workerVersion);
  return digest12({
    kind: 'catalog',
    files: files.map((f) => ({ path: f.path, content: f.contentSha256 })),
    worker: workerVersion,
    args: args ?? [],
  });
}

/**
 * The digest of a parsed catalog, as it enters every lineage shard key. Computed
 * over the RECORDS (not the DDL text) because that is what lineage.py consumes:
 * two different DDL spellings that parse to the same catalog must reuse lineage.
 * @param {object[]} catalogRecords
 * @returns {string} 12-char hex
 */
export function catalogDigestOf(catalogRecords) {
  if (!Array.isArray(catalogRecords)) throw new FactsStoreError('catalogRecords must be an array');
  // The header record carries counts only; keep it out so a header shape change
  // does not invalidate every statement's lineage.
  return digest12(catalogRecords.filter((r) => r && r.kind !== 'header'));
}

// ---------------------------------------------------------------------------
// JavaFacts records: split, order, splice (pure)
// ---------------------------------------------------------------------------

// The worker's internal sort-key separator (JavaFacts.java `SEP`). Built with
// fromCharCode so no literal control byte enters this source file.
const SEP = String.fromCharCode(1);

/**
 * The sort key JavaFacts.java assigns a record, reproduced here.
 *
 * WHY REPRODUCE IT: a cold run emits ONE globally sorted stream; an incremental
 * run reassembles the same records from per-file shards. The graph builder is
 * not perfectly order-blind (a Map's last write wins for an overloaded method's
 * line number, for an endpoint declared twice, ...), so the assembled stream must
 * carry the worker's own order — not merely the same multiset. `test/facts_store.test.mjs`
 * proves the reproduction byte-for-byte against real worker output.
 *
 * The worker appends a global call counter to a `call` key; it is NOT reproduced,
 * because records that agree on everything before it are byte-identical JSON and
 * their relative order therefore cannot change the assembled bytes.
 *
 * @param {object} rec
 * @returns {string|null} null for records that are not shard content (header)
 */
function padLine(line) {
  const n = String(Math.max(Number.isInteger(line) ? line : 0, 0));
  return '0'.repeat(Math.max(0, 8 - n.length)) + n;
}

export function javaRecordSortKey(rec) {
  if (!rec || typeof rec !== 'object') return null;
  switch (rec.kind) {
    case 'parse_error': return `0parse${SEP}${rec.file}`;
    case 'import': return `1import${SEP}${rec.owner}${SEP}${rec.simple}${SEP}${rec.fqn}`;
    case 'entity': return `2entity${SEP}${rec.fqn}`;
    case 'repository': return `2repo${SEP}${rec.fqn}`;
    case 'type': return `2type${SEP}${rec.fqn}`;
    case 'mpEntity': return `2mpentity${SEP}${rec.fqn}`;
    case 'mpMapper': return `2mpmapper${SEP}${rec.fqn}`;
    case 'mpService': return `2mpservice${SEP}${rec.fqn}${SEP}${rec.base}`;
    case 'field': return `3field${SEP}${rec.owner}${SEP}${rec.name}`;
    case 'endpoint': return `4endpoint${SEP}${rec.handler}${SEP}${rec.httpMethod}${SEP}${rec.path}`;
    case 'method': return `5method${SEP}${rec.fqn}${SEP}${rec.paramCount}`;
    case 'mapperAnnotationSql': return `5mapsql${SEP}${rec.ownerFqn}${SEP}${rec.method}${SEP}${rec.verb}`;
    case 'transactional': return `6tx${SEP}${rec.method}`;
    case 'call': return `6call${SEP}${rec.from}${SEP}${rec.receiver}${SEP}${rec.method}${SEP}${rec.toTypeSimple}${SEP}${rec.via}`;
    // The worker appends its own running counter here too (see the note above):
    // records that agree on everything before it are byte-identical JSON, so
    // their relative order cannot change the assembled bytes.
    case 'mpWrapper': return `7mpwrapper${SEP}${rec.from}${SEP}${padLine(rec.line)}${SEP}${rec.var == null ? '' : rec.var}`;
    // …and here (javafacts/8): two imperative HTTP calls that agree on the
    // caller, the line, the verb and the path are byte-identical JSON.
    case 'httpCall': return `8httpcall${SEP}${rec.from}${SEP}${padLine(rec.line)}${SEP}${rec.httpMethod == null ? '' : rec.httpMethod}${SEP}${rec.path == null ? '' : rec.path}`;
    default: return null; // header, summary, and anything a newer worker adds
  }
}

/**
 * Split a JavaFacts stream into per-file record lists.
 *
 * Records without a `file` (the header) are NOT shard content and are dropped:
 * the header is a per-RUN tally, and a run's tally means nothing once its facts
 * are cached per file.
 * @param {object[]} records
 * @returns {{byFile:Map<string,object[]>, skipped:number}}
 */
export function splitJavaFactsByFile(records) {
  if (!Array.isArray(records)) throw new FactsStoreError('records must be an array');
  const byFile = new Map();
  let skipped = 0;
  for (const r of records) {
    if (!r || typeof r !== 'object' || typeof r.file !== 'string' || javaRecordSortKey(r) === null) {
      skipped += 1;
      continue;
    }
    let list = byFile.get(r.file);
    if (!list) { list = []; byFile.set(r.file, list); }
    list.push(r);
  }
  return { byFile, skipped };
}

/**
 * Reassemble a whole-project JavaFacts stream from per-file shards, in the order
 * the worker itself would have emitted it.
 * @param {Iterable<object[]>|Map<string,object[]>} shards
 * @returns {object[]}
 */
export function assembleJavaFacts(shards) {
  const lists = shards instanceof Map ? [...shards.values()] : [...shards];
  const flat = [];
  for (const list of lists) for (const r of list ?? []) flat.push(r);
  // Decorate-sort-undecorate: the key is computed once per record, and the sort
  // is stable, so byte-identical duplicates keep their relative order.
  const decorated = flat.map((r, i) => ({ r, k: javaRecordSortKey(r) ?? '', i }));
  decorated.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : a.i - b.i));
  return decorated.map((d) => d.r);
}

/**
 * Replace and drop per-file shards IN MEMORY, leaving the store untouched.
 *
 * This is the splice the working-tree overlay (RM4/§10.2) needs: it holds the
 * committed shards, swaps in facts freshly parsed from the editor buffer for the
 * files being edited, drops the files that were deleted, and re-runs the bridge —
 * without writing anything to the cache, because an uncommitted edit must not
 * become a cached fact.
 * @param {Map<string,object[]>} allShards  file -> records (not mutated)
 * @param {{replaceForFiles?:Map<string,object[]>|Iterable<[string,object[]]>, dropFiles?:Iterable<string>}} [ops]
 * @returns {Map<string,object[]>} a new map
 */
export function spliceFacts(allShards, ops = {}) {
  if (!(allShards instanceof Map)) throw new FactsStoreError('allShards must be a Map of file -> records');
  const out = new Map(allShards);
  for (const f of ops.dropFiles ?? []) out.delete(f);
  const replace = ops.replaceForFiles instanceof Map ? ops.replaceForFiles : new Map(ops.replaceForFiles ?? []);
  for (const [f, recs] of replace) {
    if (!Array.isArray(recs)) throw new FactsStoreError(`replaceForFiles[${f}] must be an array of records`);
    out.set(f, recs);
  }
  return out;
}

// ---------------------------------------------------------------------------
// webfacts records: split, order, assemble, summarize (pure)
// ---------------------------------------------------------------------------

/**
 * The `config` records that belong to a PACKAGE rather than to a source file.
 *
 * `adapters/web/webfacts.mjs` emits `config` records from two places: a package
 * directory (its `.env*` values, its dev-server proxy rules, its path aliases)
 * and a source file (an `axios.defaults.baseURL = …` assignment, which is code).
 * Only the first group is package-level, and only the first group is left out of
 * the per-file shards, because a package's configuration is not a fact ABOUT the
 * file it happens to be written in.
 */
const WEB_PACKAGE_CONFIG_WHAT = new Set(['env', 'proxy', 'alias']);

/**
 * The sort key adapters/web/webfacts.mjs assigns a record, reproduced here.
 *
 * The worker prints files in sorted root-relative path order and, inside one
 * file, in (line, file-record-first, kind, emit ordinal) order. The ORDINAL is
 * not on the record and is not reproduced: every record with the same file sits
 * in the same shard, in the order the worker emitted it, so a STABLE sort on the
 * key below leaves those in exactly the order they arrived. That is what makes
 * `assembleWebFacts` byte-identical to a cold run rather than merely equivalent
 * (pinned in test/facts_store.test.mjs against real worker output).
 *
 * @param {object} rec
 * @returns {string|null} null for records that are not shard content
 */
export function webRecordSortKey(rec) {
  if (!rec || typeof rec !== 'object') return null;
  if (typeof rec.file !== 'string' || rec.file.length === 0) return null;
  if (rec.kind === 'header' || rec.kind === 'summary') return null;
  // The worker puts the `file` record of a line before everything else on it.
  const rank = rec.kind === 'file' ? '0' : '1';
  return `${rec.file}${SEP}${padLine(rec.line)}${SEP}${rank}${SEP}${rec.kind}`;
}

/**
 * Split a webfacts stream into per-file record lists, leaving the package-level
 * configuration out.
 *
 * @param {object[]} records
 * @param {{configFiles?:Iterable<string>}} [opts]
 *        the files the package-config run owns (every path the worker's
 *        `--configs-only` mode printed). A `file` or `parse_error` record for
 *        one of those describes a config file the config run re-reads on every
 *        run, so sharding it would emit it twice. Naming the set beats guessing
 *        it from the file NAME: a project may legitimately keep a file called
 *        `vite.config.ts` inside its sources.
 * @returns {{byFile:Map<string,object[]>, configRecords:object[], skipped:number}}
 */
export function splitWebFactsByFile(records, opts = {}) {
  if (!Array.isArray(records)) throw new FactsStoreError('records must be an array');
  const configFiles = new Set(opts.configFiles ?? []);
  const byFile = new Map();
  const configRecords = [];
  let skipped = 0;
  for (const r of records) {
    if (webRecordSortKey(r) === null) { skipped += 1; continue; }
    if ((r.kind === 'config' && WEB_PACKAGE_CONFIG_WHAT.has(r.what)) || configFiles.has(r.file)) {
      configRecords.push(r);
      continue;
    }
    let list = byFile.get(r.file);
    if (!list) { list = []; byFile.set(r.file, list); }
    list.push(r);
  }
  return { byFile, configRecords, skipped };
}

/**
 * Reassemble a whole-project webfacts stream from per-file shards plus the
 * package configuration, in the order the worker itself would have printed it.
 *
 * The config records are NOT appended at one end: they carry a file and a line
 * like any other record, so the sort key decides where they land, which is
 * exactly where a cold run put them.
 *
 * @param {Iterable<object[]>|Map<string,object[]>} shards
 * @param {object[]} [configRecords]
 * @returns {object[]}
 */
export function assembleWebFacts(shards, configRecords = []) {
  const lists = shards instanceof Map ? [...shards.values()] : [...shards];
  const flat = [];
  for (const list of lists) for (const r of list ?? []) flat.push(r);
  for (const r of configRecords) flat.push(r);
  const decorated = flat.map((r, i) => ({ r, k: webRecordSortKey(r) ?? '', i }));
  decorated.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : a.i - b.i));
  return decorated.map((d) => d.r);
}

/**
 * The counts a cold worker run prints in its `summary` record, recomputed from a
 * record stream.
 *
 * WHY THIS EXISTS: the summary is a per-RUN tally, so it cannot be cached, and an
 * incremental run has no single worker invocation to read one from. Rather than
 * keep a stale summary or leave the lane's counts blank, they are derived from
 * the assembled records — the same records the bridge sees, so the numbers the
 * pack reports and the facts it was built from can never describe two different
 * runs. `test/facts_store.test.mjs` checks this against the worker's own summary.
 *
 * @param {object[]} records  an assembled webfacts stream (no header/summary needed)
 * @returns {object} the summary's counts, without `kind`/`version`
 */
export function webFactsSummary(records) {
  if (!Array.isArray(records)) throw new FactsStoreError('records must be an array');
  const counts = {
    files: 0, parseErrors: 0, recoveredErrors: 0,
    vueFiles: 0, tsFiles: 0, jsFiles: 0, skippedFiles: 0,
    imports: 0, exports: 0, functions: 0, constants: 0, bindings: 0,
    classes: 0, assigns: 0,
    calls: 0, callsWithUrl: 0,
    urlByShape: { literal: 0, template: 0, constant: 0, unresolved: 0 },
    methodBySource: { 'callee-name': 0, config: 0, positional: 0 },
    routes: 0, byPack: {}, aliases: 0, proxies: 0, envRecords: 0,
    envFiles: 0,
    platformSinks: { fetch: 0, xhr: 0 },
  };
  const withFileRecord = new Set();
  const errorOnly = new Set();
  const envFiles = new Set();
  for (const r of records) {
    if (!r || typeof r !== 'object') continue;
    switch (r.kind) {
      case 'file':
        withFileRecord.add(r.file);
        if (r.lang === 'vue') counts.vueFiles += 1;
        else if (r.lang === 'ts' || r.lang === 'tsx') counts.tsFiles += 1;
        else counts.jsFiles += 1;
        if (r.skipped) counts.skippedFiles += 1;
        counts.recoveredErrors += r.recoveredErrors ?? 0;
        break;
      case 'parse_error':
        counts.parseErrors += 1;
        errorOnly.add(r.file);
        break;
      case 'import': counts.imports += 1; break;
      case 'export': counts.exports += 1; break;
      case 'function': counts.functions += 1; break;
      case 'constant': counts.constants += 1; break;
      case 'binding': counts.bindings += 1; break;
      case 'class': counts.classes += 1; break;
      case 'assign': counts.assigns += 1; break;
      case 'route':
        counts.routes += 1;
        counts.byPack[r.pack] = (counts.byPack[r.pack] ?? 0) + 1;
        break;
      case 'config':
        if (r.what === 'alias') counts.aliases += 1;
        else if (r.what === 'proxy') counts.proxies += 1;
        else if (r.what === 'env') { counts.envRecords += 1; envFiles.add(r.file); }
        break;
      case 'call': {
        counts.calls += 1;
        if (r.platformSink === 'fetch') counts.platformSinks.fetch += 1;
        if (r.platformSink === 'xhr') counts.platformSinks.xhr += 1;
        if (r.method && r.method.from) {
          counts.methodBySource[r.method.from] = (counts.methodBySource[r.method.from] ?? 0) + 1;
        }
        if (r.url) {
          counts.callsWithUrl += 1;
          const first = r.url.resolved && r.url.resolved[0];
          if (!first) counts.urlByShape.unresolved += 1;
          else if (first.via === 'literal') counts.urlByShape.literal += 1;
          else if (first.via === 'template') counts.urlByShape.template += 1;
          else counts.urlByShape.constant += 1;
        }
        break;
      }
      default: break;
    }
  }
  // A file the worker READ is one that produced a `file` record, plus one it
  // could not parse or could not read at all: those produce a parse_error and no
  // `file` record, and dropping them would under-report what the lane looked at.
  for (const f of errorOnly) if (!withFileRecord.has(f)) withFileRecord.add(f);
  counts.files = withFileRecord.size;
  counts.envFiles = envFiles.size;
  return counts;
}

// ---------------------------------------------------------------------------
// The facts index (pure)
// ---------------------------------------------------------------------------

/**
 * A fresh, empty index. It lives at `<packDir>/facts-index.json`, OUTSIDE the
 * pack digest: it maps inputs to shards, it is not itself a fact.
 * @param {{project:string, engineVersion:string, workers:object, root:string,
 *          selection:object, base:(object|null)}} head
 * @returns {object}
 */
export function emptyIndex(head) {
  return {
    schema: FACTS_INDEX_SCHEMA,
    project: head.project,
    engineVersion: head.engineVersion,
    workers: head.workers,
    root: head.root,
    selection: head.selection,
    base: head.base ?? null,
    files: {},
    statements: {},
    catalog: null,
  };
}

/**
 * Validate a loaded index. Returns the index, or throws — a malformed index must
 * become a COLD run with a stated reason, never a partially trusted one.
 * @param {unknown} idx
 * @returns {object}
 */
export function validateIndex(idx) {
  if (!idx || typeof idx !== 'object') throw new FactsStoreError('facts index is not an object');
  if (idx.schema !== FACTS_INDEX_SCHEMA) {
    throw new FactsStoreError(`unknown facts index schema ${JSON.stringify(idx.schema)} (expected ${FACTS_INDEX_SCHEMA})`);
  }
  for (const k of ['project', 'engineVersion', 'root']) {
    if (typeof idx[k] !== 'string') throw new FactsStoreError(`facts index field ${k} must be a string`);
  }
  if (!idx.workers || typeof idx.workers !== 'object') throw new FactsStoreError('facts index field workers must be an object');
  if (!idx.files || typeof idx.files !== 'object') throw new FactsStoreError('facts index field files must be an object');
  if (!idx.statements || typeof idx.statements !== 'object') throw new FactsStoreError('facts index field statements must be an object');
  for (const [f, e] of Object.entries(idx.files)) {
    if (!e || typeof e.shardKey !== 'string' || typeof e.sha256 !== 'string' || typeof e.lines !== 'number') {
      throw new FactsStoreError(`facts index entry for ${f} is missing shardKey/sha256/lines`);
    }
  }
  return idx;
}

/** Canonical bytes for the index file (stable across runs). */
export function serializeIndex(idx) {
  return canonicalJson(idx) + '\n';
}

// ---------------------------------------------------------------------------
// The store (pure over injected io)
// ---------------------------------------------------------------------------

/**
 * A shard store rooted at the project's content-addressed cache.
 *
 * @param {{io:{readFile:(p:string)=>string, writeFile:(p:string,s:string)=>void,
 *           exists:(p:string)=>boolean, mkdir:(p:string)=>void},
 *          projectId:string, env?:NodeJS.ProcessEnv}} opts
 */
export function createFactsStore({ io, projectId, env = {} }) {
  for (const fn of ['readFile', 'writeFile', 'exists', 'mkdir']) {
    if (typeof (io ?? {})[fn] !== 'function') throw new FactsStoreError(`io.${fn} must be a function`);
  }

  const dirFor = (kind, key) => {
    if (!SHARD_KINDS.includes(kind)) throw new FactsStoreError(`unknown shard kind ${JSON.stringify(kind)}`);
    return casDir(projectId, kind, key, env);
  };
  const fileFor = (kind, key) => `${dirFor(kind, key)}/${SHARD_FILE}`;

  return {
    dirFor,
    fileFor,
    /** Does a shard with this key exist on disk? (Existence only — not integrity.) */
    has(kind, key) { return io.exists(fileFor(kind, key)); },

    /**
     * Read a shard. When `expect` is given ({sha256, lines} from the index), the
     * bytes are VERIFIED: a truncated or edited shard throws instead of feeding
     * the graph garbage. Callers turn that throw into "recompute this unit, with
     * a diagnostic".
     * @returns {{records:object[], sha256:string, lines:number}}
     */
    read(kind, key, expect = null) {
      const file = fileFor(kind, key);
      if (!io.exists(file)) throw new FactsStoreError(`shard ${kind}-${key} is missing from the cache (${file})`);
      const text = io.readFile(file);
      const got = sha256(text);
      const lines = text.length === 0 ? [] : text.split('\n').filter((l) => l.length > 0);
      if (expect) {
        if (typeof expect.sha256 === 'string' && expect.sha256 !== got) {
          throw new FactsStoreError(`shard ${kind}-${key} is corrupt: content sha256 ${got.slice(0, 12)} != recorded ${expect.sha256.slice(0, 12)} (${file})`);
        }
        if (typeof expect.lines === 'number' && expect.lines !== lines.length) {
          throw new FactsStoreError(`shard ${kind}-${key} is truncated: ${lines.length} line(s) on disk, ${expect.lines} recorded (${file})`);
        }
      }
      let records;
      try { records = lines.map((l) => JSON.parse(l)); }
      catch (e) { throw new FactsStoreError(`shard ${kind}-${key} does not parse as JSONL: ${e.message} (${file})`); }
      return { records, sha256: got, lines: lines.length };
    },

    /**
     * Write a shard (idempotent — the same key always carries the same bytes).
     * @returns {{sha256:string, lines:number, file:string}}
     */
    write(kind, key, records) {
      if (!Array.isArray(records)) throw new FactsStoreError('records must be an array');
      const text = records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');
      const dir = dirFor(kind, key);
      const file = `${dir}/${SHARD_FILE}`;
      io.mkdir(dir);
      io.writeFile(file, text);
      return { sha256: sha256(text), lines: records.length, file };
    },
  };
}

// ---------------------------------------------------------------------------
// The ONE filesystem-backed adapter (kept obviously apart from the pure half)
// ---------------------------------------------------------------------------

/**
 * The real `io` for `createFactsStore`, over node:fs. Writes go through a
 * temp file + rename so a killed run never leaves a half-written shard that a
 * later run would read as valid.
 * @param {typeof import('node:fs')} fs
 * @returns {{readFile:Function, writeFile:Function, exists:Function, mkdir:Function}}
 */
export function nodeFactsIo(fs) {
  return {
    readFile: (p) => fs.readFileSync(p, 'utf8'),
    writeFile: (p, s) => {
      const tmp = `${p}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, s, 'utf8');
      fs.renameSync(tmp, p);
    },
    exists: (p) => fs.existsSync(p),
    mkdir: (p) => fs.mkdirSync(p, { recursive: true }),
  };
}

function requireString(name, v) {
  if (typeof v !== 'string' || v.length === 0) throw new FactsStoreError(`${name} must be a non-empty string`);
}

export class FactsStoreError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FactsStoreError';
  }
}
