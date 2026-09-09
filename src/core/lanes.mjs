// lanes.mjs — "what can this run actually analyze, and what will it have to
// declare missing?" (SPEC §10.4, §15 M4).
//
// Two decisions live here, and both are PURE so they can be tested without a
// filesystem, a Python interpreter or a JDK:
//
// There are three lane inputs, not two: the SQL lane's files, the Java lane's
// source roots, and the WEB lane's frontend source roots. The web axis is
// `shipped` only when nothing about it was guessed (see `webAxis`): a prefix
// chosen by counting matches, an alias this engine assumed and a call it could
// not trace each make it `degraded`, and the reason names which, so a reader is
// told what to declare rather than left to infer it.
//
//  1. LANE SELECTION — `selectLanes` turns (flags + manifest + profile +
//     discovery) into the concrete inputs each lane gets. Explicit flags always
//     win; what the user did not spell out comes from the profile's
//     `frameworkPacks` / `catalog` and from what `discover()` measured. An axis
//     with no input is NOT an error: the run goes ahead without it (§10.4 MUST —
//     the pack builder never dies for a missing axis) and the axis is declared.
//
//  2. DECLARED AXES — `declareAxes` states, per axis, `shipped` / `degraded` /
//     `not-shipped` AND why. This is what the tool layer reads to answer
//     "0 results" honestly: a column axis that ran without a DB catalog says
//     `degraded` with the reason, instead of looking like a clean empty answer.
//
// The SQL lane's command-line arguments are built here too (`sqlLaneArgs`), so
// the profile keys `schema.default`, `schema.propertyNames`, `sqlDialects`,
// `sqlIdentifierCase` and `catalog.*` have exactly ONE consumption point (I-5).

import path from 'node:path';
import { sqlDialectOf, sqlIdentifierCaseOf } from './profile.mjs';
import { ROUTER_PACKS } from './discover.mjs';

/**
 * THE SCREEN AXIS SWITCH, in three states. PURE.
 *
 * `screenAxis.enabled` is the user's word when they gave one:
 *
 *   true   build screens, whatever this run happens to read
 *   false  build none, whatever this run happens to read
 *   null   (or the key absent) decide it from what the run READS
 *
 * The third state exists because the second is the wrong default for a real
 * layout. `cascade init` turns the axis on when it finds a router package
 * INSIDE the analyzed tree, and a backend whose frontend is checked out beside
 * it has no such package: the run then reads a whole frontend, resolves its
 * calls onto real routes, and builds no screen at all, for a reason that has
 * nothing to do with the code. So with no word from the user the answer is what
 * the run reads: a router declaration pack named in `frameworkPacks`, or a
 * frontend package this run really reads depending on a router.
 *
 * @param {Object|null} profile  a normalized profile
 * @param {{webPackages?:{router:(string|null)}[], templateRoots?:{engine:string}[]}} [evidence]
 *        the frontend packages this run will really read, in-tree or beside it,
 *        and the template roots it will read for server-rendered pages (RM48)
 * @returns {{enabled:boolean, from:('profile'|'declared-router'|'read-router'|'nothing-read'), reason:string}}
 */
export function screenAxisOf(profile, evidence = {}) {
  const asked = profile && profile.screenAxis && typeof profile.screenAxis === 'object'
    ? profile.screenAxis.enabled : undefined;
  if (asked === true) {
    return { enabled: true, from: 'profile', reason: 'the profile sets screenAxis.enabled to true' };
  }
  if (asked === false) {
    return { enabled: false, from: 'profile', reason: 'the profile sets screenAxis.enabled to false' };
  }
  const packs = Array.isArray(profile && profile.frameworkPacks) ? profile.frameworkPacks : [];
  const declared = ROUTER_PACKS.filter((p) => packs.includes(p));
  if (declared.length > 0) {
    return {
      enabled: true,
      from: 'declared-router',
      reason: `screenAxis.enabled is undeclared and frameworkPacks names the router pack(s) ${declared.join(', ')}`,
    };
  }
  const read = [...new Set((evidence.webPackages ?? [])
    .map((p) => (p && typeof p.router === 'string' ? p.router : null))
    .filter((r) => r !== null))].sort();
  if (read.length > 0) {
    return {
      enabled: true,
      from: 'read-router',
      reason: `screenAxis.enabled is undeclared and a frontend package this run reads depends on ${read.join(', ')}`,
    };
  }
  // A SERVER-RENDERED APPLICATION HAS SCREENS AND NO ROUTER (RM48). Its pages
  // are template files a `@Controller` names, so what says "build screens" is
  // that this run reads a template root at all.
  const templateRoots = Array.isArray(evidence.templateRoots) ? evidence.templateRoots : [];
  if (templateRoots.length > 0) {
    const engines = [...new Set(templateRoots.map((r) => (r && typeof r.engine === 'string' ? r.engine : 'plain-html')))].sort();
    return {
      enabled: true,
      from: 'server-views',
      reason: `screenAxis.enabled is undeclared and this run reads ${templateRoots.length} template root(s) (${engines.join(', ')}), whose pages a controller names`,
    };
  }
  return {
    enabled: false,
    from: 'nothing-read',
    reason: 'screenAxis.enabled is undeclared, frameworkPacks names no router pack, no frontend package this run reads depends on one, and this run reads no template root',
  };
}

/**
 * THE NAMES THIS RUN STAMPS ON ITS ROUTES SIDECAR, in two states.
 *
 * The profile's `serviceNames` is the user's word and wins. When it is empty,
 * the run uses what THIS RUN's discovery read out of the tree
 * (`spring.application.name`), because a project whose profile predates the
 * round has no reason to answer to nothing: `cascade analyze` already walks the
 * tree for its lanes, the name is in that walk, and a sidecar without it cannot
 * tell two projects serving the same path apart.
 *
 * What it does NOT do is write anything back. The profile is `cascade init`'s
 * to write, so the run says the name is not recorded yet and how to record it,
 * rather than editing a file nobody asked it to edit. The pack is untouched
 * either way: the name lives in the sidecar and in the profile, never in the
 * graph, so no digest moves.
 *
 * @param {Object|null} profile  a normalized profile
 * @param {{serviceNames?:{name:string, file:string}[]}|null} [discovery]
 *        this run's discovery, or null when no lane needed one
 * @returns {{names:string[], from:('profile'|'discovery'|'none'), files:string[]}}
 */
export function serviceNamesOf(profile, discovery = null) {
  const declared = Array.isArray(profile && profile.serviceNames)
    ? profile.serviceNames.filter((s) => typeof s === 'string' && s.length > 0)
    : [];
  if (declared.length > 0) return { names: [...new Set(declared)], from: 'profile', files: [] };
  const found = Array.isArray(discovery && discovery.serviceNames) ? discovery.serviceNames : [];
  const names = [...new Set(found
    .map((s) => (s && typeof s.name === 'string' ? s.name : ''))
    .filter((n) => n.length > 0))].sort();
  if (names.length === 0) return { names: [], from: 'none', files: [] };
  return {
    names,
    from: 'discovery',
    files: [...new Set(found.map((s) => (s && typeof s.file === 'string' ? s.file : '')).filter((f) => f.length > 0))].sort(),
  };
}

/** The axes a pack declares, in the order `overview` lists them. */
export const AXES = Object.freeze(['catalog', 'statements', 'column', 'jpa', 'mybatisPlus', 'code', 'web', 'screen']);

/** Axis statuses. `degraded` = the axis ran, but with a known loss of resolution. */
export const AXIS_STATUS = Object.freeze(['shipped', 'degraded', 'not-shipped']);

/**
 * The arguments the SQL lane workers take from the profile. Pure — the caller
 * turns them into a process invocation.
 *
 * `identifierCase` is passed to the worker EXPLICITLY rather than left to the
 * worker's own dialect table, because the two sides do not see the same name:
 * the worker is handed a sqlglot dialect (`hsqldb` routes to sqlglot's ANSI
 * parser, which has no case rule), while the rule belongs to the database the
 * PROFILE named. One decision, made here, printed in the lineage summary.
 *
 * @param {Object} profile  a normalized profile
 * @returns {{dialect:string, identifierCase:string, defaultSchema:(string|null),
 *            schemaProperties:string[], lineageArgs:string[], mybatisArgs:string[]}}
 */
export function sqlLaneArgs(profile) {
  const dialect = sqlDialectOf(profile);
  const identifierCase = sqlIdentifierCaseOf(profile);
  const schema = (profile && profile.schema) || {};
  const defaultSchema = schema.default ?? null;
  const schemaProperties = Array.isArray(schema.propertyNames) ? schema.propertyNames.slice() : [];

  const lineageArgs = ['--dialect', dialect, '--identifier-case', identifierCase];
  if (defaultSchema) lineageArgs.push('--default-schema', defaultSchema);

  const mybatisArgs = [];
  if (defaultSchema) mybatisArgs.push('--default-schema', defaultSchema);
  for (const p of schemaProperties) mybatisArgs.push('--schema-property', p);

  return { dialect, identifierCase, defaultSchema, schemaProperties, lineageArgs, mybatisArgs };
}

/**
 * THE CATALOG AXIS. A schema is often SPLIT across files, so this is a set of
 * files in order and not one file; it can also come from a PINNED SNAPSHOT that
 * `cascade catalog` wrote, which is a reading of a live database rather than of
 * the DDL in the tree.
 */
function chooseCatalog(ctx) {
  const { flags, profile, discovery, root, cwd, manifestDir, catalog, diagnostics, input } = ctx;
// ---- DDL (the catalog axis) ---------------------------------------------
// `noDdl` is the user saying "run WITHOUT a catalog" out loud (`--no-ddl`);
// `noMappers` and `noJava` are its two siblings. Each is the ONLY way to
// override a manifest/profile/discovery that would otherwise supply that
// lane, and each produces a partial pack whose missing axis is declared.
// A SET of files, in order, not one file (RM20 §3). A schema is often split —
// one file per service, one file per dialect, a base plus an ordered migration
// sequence — and `--ddl` is repeatable so the user can say so.
let ddls = flags.noDdl ? [] : asPathList(flags.ddl).map((p) => path.resolve(cwd, p));
let ddlSource = ddls.length > 0 ? 'flag' : 'none';
// The DDL classification this run used, so the caller can PRINT it. Empty
// unless discovery chose the set (a flag or a profile is the user's own words
// and needs no explanation).
let ddlChoice = null;
// The catalog can also come from a PINNED SNAPSHOT that `cascade catalog
// fetch` wrote (SPEC §12, §15 M5). It is still a FILE to this run: analysis
// never opens a database connection (§2.3 — zero network calls in the
// extraction path), it reads the snapshot the user fetched deliberately.
let snapshot = null;
if (ddls.length === 0 && !flags.noDdl) {
  const source = catalog.source ?? 'none';
  const declared = asPathList(catalog.connectionFrom);
  if (source === 'jdbc') {
    if (nonEmpty(input.catalogSnapshot)) {
      snapshot = path.resolve(input.catalogSnapshot);
    } else {
      diagnostics.push({
        kind: 'MISSING_INPUT', severity: 'warn', key: 'catalog.source',
        reason: 'catalog.source is "jdbc", but this run has no project state directory to hold the snapshot. Run `cascade init`, then `cascade catalog fetch`',
      });
    }
  } else if (source === 'file' && declared.length > 0) {
    // A string or an array, in the order written: `catalog.connectionFrom` is
    // the project saying which files ARE its schema, and a schema split over
    // three services is still one schema.
    ddls = declared.map((p) => path.resolve(manifestDir ?? root, p));
    ddlSource = 'profile';
  } else if (source === 'file') {
    diagnostics.push({
      kind: 'MISSING_INPUT', severity: 'warn', key: 'catalog.connectionFrom',
      reason: 'catalog.source is "file", but catalog.connectionFrom is empty. There is no DDL to read, so this run gets no table or column names from a schema',
    });
  } else {
    // NOBODY SAID. Discovery classified every .sql it found by dialect and by
    // role; the default is every SCHEMA file of the dialect this project
    // declares (or, absent a declaration, the dialect most of them are written
    // in), applied in path order. Migrations are NOT applied: a migration
    // means nothing without the schema it amends and without its siblings in
    // the right order, and guessing that order would be the engine inventing
    // a history. The choice — and everything left out — is returned so the
    // caller prints it.
    ddlChoice = chooseDdlFiles(discovery?.ddlCandidates ?? [], profile);
    if (ddlChoice.chosen.length > 0) {
      ddls = ddlChoice.chosen.map((c) => path.resolve(root, c.path));
      ddlSource = 'discovery';
    }
  }
}

  return { ddls, ddlSource, ddlChoice, snapshot };
}

/**
 * THE STATEMENT AND CODE AXES. The same three-way rule for both: the flag wins,
 * otherwise the framework pack the profile declares turns discovery's finding
 * into an input, and a default run reads MAIN sources only — test sources are a
 * different program.
 */
function chooseJavaLanes(ctx) {
  const { flags, discovery, root, cwd, packs, diagnostics } = ctx;
// ---- mapper XML (the statement axis) ------------------------------------
let mappers = flags.noMappers ? [] : (flags.mappers ?? []).map((m) => path.resolve(cwd, m));
let mapperSource = mappers.length ? 'flag' : 'none';
if (mappers.length === 0 && !flags.noMappers && packs.includes('mybatis-xml')) {
  const dirs = discovery && Array.isArray(discovery.mapperDirs) ? discovery.mapperDirs : [];
  mappers = dirs.map((d) => path.resolve(root, d));
  if (mappers.length > 0) mapperSource = 'discovery';
  else {
    diagnostics.push({
      kind: 'MISSING_INPUT', severity: 'warn', key: 'frameworkPacks',
      reason: 'frameworkPacks declares mybatis-xml, but discovery found no directory holding a <mapper namespace=…> XML file',
    });
  }
}

// ---- Java sources (the code axis) ---------------------------------------
// A DEFAULT run reads main sources only: test sources are a different program
// (they call production code, they carry no route the service serves). The
// roots that were left out are returned so the caller can PRINT them — the
// exclusion is a stated default, never a silent filter. `--java-src <a test
// root>` is honoured, because the user asked for it by name.
let javaSrc = flags.noJava ? [] : (flags.javaSrc ?? []).map((d) => path.resolve(cwd, d));
let javaSource = javaSrc.length ? 'flag' : 'none';
let excludedTestRoots = [];
if (javaSrc.length === 0 && !flags.noJava && packs.includes('spring-mvc')) {
  const roots = discovery && Array.isArray(discovery.javaSourceRoots) ? discovery.javaSourceRoots : [];
  const testRoots = discovery && Array.isArray(discovery.javaTestRoots) ? discovery.javaTestRoots : [];
  javaSrc = roots.map((d) => path.resolve(root, d));
  excludedTestRoots = testRoots.slice().sort();
  if (javaSrc.length > 0) javaSource = 'discovery';
  else {
    diagnostics.push({
      kind: 'MISSING_INPUT', severity: 'warn', key: 'frameworkPacks',
      reason: testRoots.length > 0
        ? `frameworkPacks declares spring-mvc, but every Java source root discovery found is a test root under the standard src/test layout (${testRoots.join(', ')}). Pass --java-src to analyze one anyway`
        : 'frameworkPacks declares spring-mvc, but discovery found no Java source root',
    });
  }
}

  return { mappers, mapperSource, javaSrc, javaSource, excludedTestRoots };
}

/**
 * THE WEB AXIS. A frontend source root, or — for a SERVER-RENDERED application,
 * which has no frontend package and often no JavaScript at all — the template
 * roots a `@Controller` names.
 */
function chooseWebLanes(ctx) {
  const { flags, profile, discovery, root, cwd, manifestDir, packs, diagnostics } = ctx;
// ---- frontend sources (the web lane, RM26) ------------------------------
// Same three-way rule as the Java lane: the flag wins, otherwise the `web`
// framework pack lets discovery's roots in, otherwise nothing runs. The pack
// being declared with nothing found is a MISSING_INPUT, not a silent skip.
let webSrc = flags.noWeb ? [] : (flags.webSrc ?? []).map((d) => path.resolve(cwd, d));
let webSource = webSrc.length ? 'flag' : 'none';
if (webSrc.length === 0 && !flags.noWeb && packs.includes('web')) {
  const roots = discovery && Array.isArray(discovery.webSourceRoots) ? discovery.webSourceRoots : [];
  // THE PROFILE'S OWN ROOTS, beside the ones a frontend package.json gives
  // (RM47). A frontend shipped as `<script>` tags declares no dependency, so
  // no walk of the tree can turn it into a package: `cascade init` writes what
  // it found into `webRoots`, and this is where that record is acted on. It is
  // read from the PROFILE and not from this run's discovery, because a web
  // root decides what is in the pack, and a pack must not change under an
  // input nobody recorded.
  const declaredRoots = Array.isArray(profile.webRoots) ? profile.webRoots : [];
  const fromProfile = declaredRoots
    .map((r) => (r && typeof r.root === 'string' ? r.root : null))
    .filter(nonEmpty)
    .map((d) => path.resolve(manifestDir ?? root, d));
  webSrc = [...roots.map((d) => path.resolve(root, d)), ...fromProfile];
  if (webSrc.length > 0) {
    webSource = fromProfile.length === 0 ? 'discovery'
      : roots.length === 0 ? 'profile' : 'discovery+profile';
  } else {
    diagnostics.push({
      kind: 'MISSING_INPUT', severity: 'warn', key: 'frameworkPacks',
      reason: 'frameworkPacks declares web, but discovery found no frontend package.json with a framework dependency and the profile names no webRoots, so there is no frontend source root to read. Pass --web-src to name one',
    });
  }
}

// ---- template roots (the server-rendered pages, RM48) -------------------
//
// A `@Controller` returning a view name has no frontend package and often no
// `.js` at all, so nothing above would run the web lane for it. The roots come
// from the PROFILE, not from this run's discovery, for the same reason
// `webRoots` does: a template root decides what is in the pack, and a pack
// must not change under an input nobody recorded. `--no-web` silences them
// like everything else on this lane.
let templateRoots = [];
let templateSource = 'none';
if (!flags.noWeb) {
  const declared = Array.isArray(profile.templateRoots) ? profile.templateRoots : [];
  templateRoots = declared
    .filter((r) => r && typeof r.root === 'string' && r.root !== '')
    .map((r) => ({
      root: path.resolve(manifestDir ?? root, r.root),
      engine: typeof r.engine === 'string' ? r.engine : 'plain-html',
      suffix: typeof r.suffix === 'string' && r.suffix !== '' ? r.suffix : '.html',
    }));
  if (templateRoots.length > 0) templateSource = 'profile';
}
templateRoots = templateRoots
  .filter((r, i) => templateRoots.findIndex((x) => x.root === r.root) === i)
  .sort((a, b) => (a.root < b.root ? -1 : a.root > b.root ? 1 : 0));

  return { webSrc, webSource, templateRoots, templateSource };
}

/**
 * THE EVIDENCE LAYERS: a declared contract, a browser recording, an execution
 * trace. The same rule once more — the flag wins, then the profile — with no
 * framework pack in the way, because none of these is a framework.
 */
function chooseEvidenceLanes(ctx) {
  const { flags, profile, discovery, root, cwd, manifestDir } = ctx;
// ---- OpenAPI documents (the declaration layer, RM29) --------------------
// The same three-way rule once more, with one difference: no framework pack
// gates it. A document is a document — a project that ships one has said what
// it serves, and reading it needs no declaration beyond the file existing.
let openapi = flags.noOpenapi ? [] : (flags.openapi ?? []).map((f) => path.resolve(cwd, f));
let openapiSource = openapi.length ? 'flag' : 'none';
if (openapi.length === 0 && !flags.noOpenapi) {
  const declared = Array.isArray(profile.openapi?.documents) ? profile.openapi.documents.filter(nonEmpty) : [];
  if (declared.length > 0) {
    openapi = declared.map((f) => path.resolve(manifestDir ?? root, f));
    openapiSource = 'profile';
  } else {
    const found = discovery && Array.isArray(discovery.openapiDocuments) ? discovery.openapiDocuments : [];
    if (found.length > 0) {
      openapi = found.map((d) => path.resolve(root, d.path));
      openapiSource = 'discovery';
    }
  }
}
openapi = [...new Set(openapi)].sort();

// ---- browser recordings (runtime evidence, RM30) ------------------------
// The flag wins, then the profile's `runtimeEvidence.har`. There is NO
// discovery step, on purpose: a HAR file is something a person recorded
// deliberately, and picking one up because it happens to be in the tree would
// let an unrelated capture decide what this pack claims was observed.
let har = (flags.har ?? []).map((f) => path.resolve(cwd, f));
let harSource = har.length ? 'flag' : 'none';
if (har.length === 0) {
  const declared = Array.isArray(profile.runtimeEvidence?.har) ? profile.runtimeEvidence.har.filter(nonEmpty) : [];
  if (declared.length > 0) {
    har = declared.map((f) => path.resolve(manifestDir ?? root, f));
    harSource = 'profile';
  }
}
har = [...new Set(har)].sort();

// ---- execution traces (runtime evidence on the dispatch axis) ----------
// The same rule once more, and for the same reason: the flag wins, then the
// profile's `runtimeEvidence.otel`, and there is NO discovery step. A trace is
// captured deliberately, and a JSON file that happens to sit in the tree must
// never be allowed to decide what this pack claims ran.
let otel = (flags.otel ?? []).map((f) => path.resolve(cwd, f));
let otelSource = otel.length ? 'flag' : 'none';
if (otel.length === 0) {
  const declared = Array.isArray(profile.runtimeEvidence?.otel) ? profile.runtimeEvidence.otel.filter(nonEmpty) : [];
  if (declared.length > 0) {
    otel = declared.map((f) => path.resolve(manifestDir ?? root, f));
    otelSource = 'profile';
  }
}
otel = [...new Set(otel)].sort();
  return { openapi, openapiSource, har, harSource, otel, otelSource };
}

/**
 * Decide what each lane runs over.
 *
 * Explicit flags win over everything. Where a flag is absent, the input is
 * derived: the DDL from `catalog.source`/`catalog.connectionFrom` (relative to
 * the manifest directory) or the pinned catalog snapshot when `catalog.source`
 * is `jdbc`, mapper directories and Java source roots from what discovery
 * measured — but only for the lanes `frameworkPacks` declares.
 *
 * @param {{
 *   flags?: {ddl?:string|string[]|null, noDdl?:boolean, mappers?:string[], noMappers?:boolean,
 *            javaSrc?:string[], noJava?:boolean, webSrc?:string[], noWeb?:boolean,
 *            openapi?:string[], noOpenapi?:boolean, har?:string[], otel?:string[]},
 *   profile?: Object,
 *   discovery?: Object|null,
 *   root?: string,
 *   manifestDir?: string|null,
 *   cwd?: string,
 *   catalogSnapshot?: string|null
 * }} input
 * @returns {{ddl:(string|null), ddls:string[], snapshot:(string|null), mappers:string[], javaSrc:string[],
 *            webSrc:string[], openapi:string[], har:string[], otel:string[],
 *            ddlChoice:(object|null),
 *            catalog:{kind:('ddl'|'snapshot'|null), path:(string|null), paths:string[], source:string},
 *            sources:{ddl:string, mappers:string, javaSrc:string, webSrc:string, openapi:string, har:string, otel:string},
 *            excludedTestRoots:string[],
 *            lanes:string[], diagnostics:Object[]}}
 */
export function selectLanes(input = {}) {
  const flags = input.flags || {};
  const profile = input.profile || {};
  const discovery = input.discovery || null;
  const root = input.root ?? '.';
  // A path the USER typed is relative to the shell they typed it in; a path
  // DISCOVERY reports is relative to the scanned root; a path the PROFILE holds
  // is relative to the manifest's own directory (SPEC §5). Three bases, on
  // purpose — resolving a flag against --root would silently rewrite it.
  const cwd = input.cwd ?? root;
  const manifestDir = input.manifestDir ?? null;
  const diagnostics = [];
  const packs = Array.isArray(profile.frameworkPacks) ? profile.frameworkPacks : [];
  const catalog = (profile && profile.catalog) || {};

  const ctx = {
    flags, profile, discovery, root, cwd, manifestDir, packs, catalog, diagnostics, input,
  };
  const chosen = chooseCatalog(ctx);
  const { ddlChoice, snapshot } = chosen;
  const chosenJava = chooseJavaLanes(ctx);
  const { mapperSource, javaSource, excludedTestRoots } = chosenJava;
  const chosenWeb = chooseWebLanes(ctx);
  const { webSource, templateRoots, templateSource } = chosenWeb;
  const { openapi, openapiSource, har, harSource, otel, otelSource } = chooseEvidenceLanes(ctx);

  // Deterministic order: the pack digest must not depend on the order the flags
  // were typed in (projectPack sorts nodes and edges, but lane RESOLUTION can
  // otherwise see types in a different order).
  const mappers = [...new Set(chosenJava.mappers)].sort();
  const javaSrc = [...new Set(chosenJava.javaSrc)].sort();
  const webSrc = [...new Set(chosenWeb.webSrc)].sort();

  // Deterministic and duplicate-free, but NOT sorted: DDL order is meaning (a
  // migration applies on top of the schema before it), so the order the user or
  // the classification gave is the order that runs.
  const ddls = chosen.ddls.filter((p, i) => chosen.ddls.indexOf(p) === i);
  const ddl = ddls[0] ?? null;

  const lanes = [];
  if (ddls.length > 0 || snapshot || mappers.length > 0) lanes.push('sql');
  if (javaSrc.length > 0) lanes.push('java');
  if (openapi.length > 0) lanes.push('openapi');
  if (webSrc.length > 0 || templateRoots.length > 0) lanes.push('web');
  // The recordings come LAST: they attach to the screens the web lane built.
  if (har.length > 0) lanes.push('har');
  // ...and the traces after those, because they annotate what every other lane
  // put in the graph rather than adding an axis of their own.
  if (otel.length > 0) lanes.push('otel');

  const ddlSource = snapshot ? 'snapshot' : chosen.ddlSource;
  return {
    // `ddl` is the FIRST of `ddls`, kept because a single-file project is still
    // the common case and every caller that only ever wanted one file reads it.
    ddl, ddls, snapshot, mappers, javaSrc, webSrc, templateRoots, openapi, har, otel,
    // How the DDL set was chosen, when discovery chose it: what was picked, what
    // was left out, and why. Null when the user said it themselves.
    ddlChoice,
    // Where the catalog axis comes from, in ONE place, so the caller does not
    // re-derive it: `ddl` (a DDL file, parsed by catalog_ddl.py) or `snapshot`
    // (JSONL already in catalog shape, read as it stands).
    catalog: snapshot
      ? { kind: 'snapshot', path: snapshot, paths: [snapshot], source: 'profile' }
      : ddl ? { kind: 'ddl', path: ddl, paths: ddls, source: ddlSource } : { kind: null, path: null, paths: [], source: 'none' },
    sources: {
      ddl: ddlSource, mappers: mapperSource, javaSrc: javaSource, webSrc: webSource,
      openapi: openapiSource, har: harSource, otel: otelSource,
      templateRoots: templateSource,
    },
    excludedTestRoots,
    lanes, diagnostics,
  };
}

/**
 * Declare what this pack ships, per axis (SPEC §10.4). Every axis is present in
 * the result; none is silently omitted.
 *
 * - `catalog`    the DDL-derived table/column schema
 * - `statements` mapper SQL statements
 * - `column`     column-level read/write facts. SHIPPED needs both a catalog and
 *                statements; statements WITHOUT a catalog still yield some
 *                column facts (wherever the SQL names a column unambiguously),
 *                so that combination is `degraded`, not `not-shipped`.
 * - `mybatisPlus` persistence declared by @TableName/BaseMapper and performed by
 *                generic CRUD nobody wrote. Same discipline as `jpa`.
 * - `jpa`        persistence declared by @Entity/Spring Data rather than written
 *                as SQL. SHIPPED when the JPA bridge ran and found entities;
 *                DEGRADED when it ran without a declared naming strategy, because
 *                every table/column name the mapping did not spell out was then
 *                DERIVED and is graded HEURISTIC.
 * - `code`       endpoints / symbols / call chains (the Java lane)
 * - `web`        what the frontend does: the call sites it makes and the routes
 *                it declares. DEGRADED whenever the lane ran, because this
 *                engine version RECORDS those facts and attaches none of them to
 *                an endpoint, so no frontend call is an edge in the graph yet.
 * - `screen`     the router's own declarations, turned into screens with a
 *                RENDERS edge onto the functions of the component each one
 *                mounts. SHIPPED when nothing about that was a guess; the four
 *                things that make it DEGRADED are spelled out in `screenAxis`.
 *
 * @param {{ddl:boolean, statements:boolean, code:boolean,
 *          java?:{typesOutsideRoots?:object[]}|null,
 *          jpa?:{entities:number, repositories:number, namingStrategyDeclared:boolean}|null,
 *          mybatisPlus?:{entities:number, statements:number, namingStrategyDeclared:boolean}|null,
 *          web?:{files:number, parseErrors:number, calls:number, callsWithUrl:number, routes:number}|null,
 *          openapi?:{paths:number, documents:object[]}|null}} ran
 * @param {{screenAxisRequested?:boolean, screenAxisReason?:string}} [opts]
 * @returns {Object} axis name -> {status, reason, notes?}
 */
export function declareAxes(ran, opts = {}) {
  const hasCatalog = ran.ddl === true;
  const hasStatements = ran.statements === true;
  const hasCode = ran.code === true;
  const jpa = ran.jpa && typeof ran.jpa === 'object' ? ran.jpa : null;
  const jpaStatements = jpa ? (jpa.statements ?? 0) : 0;
  const jpaNamingDeclared = !!(jpa && jpa.namingStrategyDeclared === true);
  const web = ran.web && typeof ran.web === 'object' ? ran.web : null;
  const openapi = ran.openapi && typeof ran.openapi === 'object' ? ran.openapi : null;
  const declaredOnly = !hasCode && !!openapi && (openapi.paths ?? 0) > 0;
  const codeNotes = codeAxisNotes(ran.java);
  const mp = ran.mybatisPlus && typeof ran.mybatisPlus === 'object' ? ran.mybatisPlus : null;
  const mpStatements = mp ? (mp.statements ?? 0) : 0;
  const mpNamingDeclared = !!(mp && mp.namingStrategyDeclared === true);
  const hasColumnFacts = hasStatements || jpaStatements > 0 || mpStatements > 0;

  const axes = {
    catalog: hasCatalog
      ? { status: 'shipped', reason: null }
      : { status: 'not-shipped', reason: 'no catalog was read here, because catalog.source is none, no snapshot was fetched, or --ddl was not given. A table or column is in this pack only where a statement named it' },
    statements: hasStatements
      ? { status: 'shipped', reason: null }
      : { status: 'not-shipped', reason: 'we analyzed no mapper XML, so this pack carries no SQL statement. Statement and join answers here are absent, not empty' },
    jpa: !jpa || (jpa.entities ?? 0) === 0
      ? {
        status: 'not-shipped',
        reason: jpa
          ? 'the JPA bridge ran but found no @Entity class, so persistence in this pack comes from mapper SQL only'
          : 'the JPA bridge did not run, because there is no Java lane or the profile declares no jpa pack. Persistence declared by @Entity or Spring Data is absent, not empty',
      }
      : jpa.namingStrategyDeclared === true
        ? { status: 'shipped', reason: null }
        : {
          status: 'degraded',
          reason: `we mapped ${jpa.entities} entity(ies) and ${jpa.repositories ?? 0} repository(ies), but the profile declares no jpa.namingStrategy. `
            + 'Where the mapping did not spell a table or column out with @Table/@Column, we DERIVED the name with Spring Boot\'s default '
            + '(CamelCase to snake_case) and graded it HEURISTIC, which means a rule guessed it. Declare the strategy and those mappings become EXACT',
        },
    // MyBatis-Plus: the CRUD nobody wrote. SHIPPED when the bridge ran and found
    // entities; DEGRADED when it ran without a declared naming strategy, because
    // every table/column name the mapping did not spell out was then DERIVED and
    // is graded HEURISTIC.
    mybatisPlus: !mp || (mp.entities ?? 0) === 0
      ? {
        status: 'not-shipped',
        reason: mp
          ? 'the MyBatis-Plus bridge ran but found no entity, so persistence in this pack is written as SQL or declared some other way'
          : 'the MyBatis-Plus bridge did not run, because there is no Java lane or the profile declares no mybatis-plus pack. Generic CRUD, condition wrappers and @TableLogic deletes are absent, not empty',
      }
      : mp.namingStrategyDeclared === true
        ? { status: 'shipped', reason: null }
        : {
          status: 'degraded',
          reason: `we mapped ${mp.entities} MyBatis-Plus entity(ies) and ${mp.statements ?? 0} generic-CRUD statement(s), but the profile declares no mybatisPlus.namingStrategy. `
            + 'Where the mapping did not spell a table or column out with @TableName/@TableField, we DERIVED the name with MyBatis-Plus\'s default '
            + '(camelCase to under_score) and graded it HEURISTIC, which means a rule guessed it. Declare the strategy and those mappings become EXACT',
        },
    // A column fact can come from EITHER lane: mapper SQL that names the column,
    // or a JPA mapping that says which column an attribute is. A pack whose only
    // statements are JPA ones derived under an ASSUMED naming strategy is
    // degraded even with a catalog — those column names were guessed by a rule,
    // not read from the source.
    column: hasColumnFacts && hasCatalog && (hasStatements || jpaNamingDeclared || mpNamingDeclared)
      ? { status: 'shipped', reason: null }
      : hasColumnFacts && hasCatalog
        ? { status: 'degraded', reason: 'where no mapper SQL names a column, we derived it from a JPA attribute name under an ASSUMED naming strategy, because the profile declares no jpa.namingStrategy. Those columns are graded HEURISTIC; declare the strategy and they become EXACT' }
        : hasColumnFacts
          ? { status: 'degraded', reason: 'the lanes ran without a DB catalog, so we attribute a column only where the statement or the mapping names it unambiguously. A column reference we could not place is recorded as unresolved rather than dropped' }
          : hasCatalog
            ? { status: 'not-shipped', reason: 'the catalog declares columns but no statement was analyzed, so nothing reads or writes them in this pack' }
            : { status: 'not-shipped', reason: 'neither a catalog nor a statement was analyzed' },
    // THE CODE AXIS WITH NO CODE LANE. A pack whose routes came only from an
    // OpenAPI document has endpoints and nothing under them: the document says
    // the route exists, and this engine read no source that serves it. That is
    // DEGRADED, not not-shipped, and the reason says exactly where the answer
    // stops so a frontend call is never read as a chain to a table.
    code: hasCode
      ? { status: 'shipped', reason: null, ...(codeNotes.length > 0 ? { notes: codeNotes } : {}) }
      : declaredOnly
        ? {
          status: 'degraded',
          reason: 'endpoints come from an OpenAPI document, not from source: the routes exist, but nothing below them is walked, '
            + 'so a frontend call reaches an endpoint and stops there',
        }
        : { status: 'not-shipped', reason: 'the Java lane did not run, so endpoints, services, @Transactional boundaries and call chains are absent, not empty' },
    // THE WEB AXIS IS SHIPPED ONLY WHEN NOTHING WAS GUESSED. The lane reads the
    // frontend, traces each call to the client that sends it and attaches it to
    // the route this pack serves. Three things can make that a guess rather than
    // a reading, and each of them is named in the reason so a reader knows what
    // to declare to make it stop: a prefix chosen by counting matches, an alias
    // this engine assumed, and a call whose callee it could not trace at all.
    web: webAxis(web),
    screen: screenAxis(web, ran.har ?? null, opts),
  };
  return axes;
}

/**
 * THE SCREEN AXIS, stated from what the bridge actually built (RM30 §F).
 *
 * SHIPPED needs three things at once: the profile turned the axis on, at least
 * one screen has a RENDERS edge (a screen nothing hangs off is a row, not an
 * axis), and nothing about the reading was a guess.
 *
 * DEGRADED names which of four things went wrong, because each has a different
 * fix and a reader who is told "degraded" and nothing else cannot act:
 *   (a) the router is filled in by the SERVER at run time. The rule is stated
 *       in full: under 30 routes declared in the source AND a call that fetches
 *       the frontend's own menu. Both halves, so a small app is not accused and
 *       a project that merely serves a /menu route is not either.
 *   (b) more than a fifth of the declared routes name a component this lane
 *       could not resolve to a file it read, so those screens show nothing.
 *   (c) the profile asks for a screen NAME this engine does not read.
 *   (d) screens were built and not one of them has a RENDERS edge.
 *
 * NOT-SHIPPED is only ever "the axis was switched off" or "no route was read".
 *
 * @param {Object|null} web  `laneStats.web`
 * @param {Object|null} har  `laneStats.har`
 * @param {{screenAxisRequested?:boolean, screenAxisReason?:string}} [opts]
 * @returns {{status:string, reason:(string|null)}}
 */
function screenAxis(web, har, opts = {}) {
  const s = web && typeof web.screens === 'object' && web.screens !== null ? web.screens : null;
  const routes = web ? (web.routes ?? 0) : 0;
  const observed = har && Number.isInteger(har.pairs) && har.pairs > 0
    ? ` A recording confirms ${har.pairs} screen-to-route pair(s) really happened, marked observed and never walked.`
    : '';
  if (!web) {
    return {
      status: 'not-shipped',
      reason: opts.screenAxisRequested === true
        ? 'the profile enables the screen axis, but no web lane ran to populate it'
        : 'the web lane did not run, so there is no router declaration to build a screen from',
    };
  }
  if (!s || s.enabled !== true) {
    const why = typeof opts.screenAxisReason === 'string' && opts.screenAxisReason.length > 0
      ? opts.screenAxisReason : 'screenAxis.enabled is false';
    return {
      status: 'not-shipped',
      reason: `the web lane recorded ${routes} route declaration(s) and the screen axis is off: ${why}, so no route was turned into a screen. `
        + 'Set screenAxis.enabled to true in the profile to build them anyway',
    };
  }
  // A SERVER-RENDERED APPLICATION DECLARES NO ROUTES AT ALL (RM48): its pages
  // are template files a `@Controller` names, so "no route declaration" is the
  // normal state and the pages are what to count.
  const pages = s.byKind && Number.isInteger(s.byKind.page) ? s.byKind.page : 0;
  if ((s.declared ?? 0) === 0 && pages === 0) {
    return {
      status: 'not-shipped',
      reason: 'the screen axis is enabled and the web lane recorded no route declaration and no page a controller renders, so there is nothing to build a screen from. '
        + 'The router packs (adapters/web/packs) name the conventions a route object is recognized by; a router none of them describes is read by none of them',
    };
  }
  const why = [];
  if (s.serverDriven && s.serverDriven.detected === true) {
    // THE CEILING IS ONLY THE WORDING. What fired the rule is the menu call;
    // how many routes the source also declares decides how much of the app is
    // missing, and therefore which sentence describes it.
    const sd = s.serverDriven;
    const declared = s.declared ?? 0;
    const most = declared < (sd.ceiling ?? 0)
      ? 'most screens arrive when the app runs'
      : `screens beyond the ${declared} declared arrive when the app runs`;
    why.push(`the app also fetches its menu from the server at run time (a call to ${(sd.menuEndpoints ?? []).join(', ')} was found): `
      + `${declared} screen(s) are declared in the source and the ones the server adds are not here, so ${most}`);
  }
  // A VIEW NAME THIS RUN COULD NOT PLACE is the page side of the same gap an
  // unresolvable component specifier is: a template root nobody declared, or a
  // name the handler built rather than wrote.
  const t = web && typeof web.templates === 'object' && web.templates !== null ? web.templates : null;
  if (t && (t.viewNames ?? 0) > 0) {
    const missed = t.viewNamesUnplaced ?? 0;
    if (missed > 0) {
      why.push(`${missed} of ${t.viewNames} view name(s) a handler returns resolve to no template this run read, so those pages are not here`);
    }
    if ((t.unresolvedViews ?? 0) > 0) {
      why.push(`${t.unresolvedViews} handler return(s) name a view this engine could not read (a variable, a call it cannot follow, a name built at run time), so those pages have no name to look up`);
    }
  }
  const unresolvedShare = (s.declared ?? 0) > 0 ? (s.componentUnresolved ?? 0) / s.declared : 0;
  if (unresolvedShare > SCREEN_UNRESOLVED_SHARE) {
    why.push(`${s.componentUnresolved} of ${s.declared} route declaration(s) name a component this lane could not resolve to a file it read, so those screens render nothing here`);
  }
  if (s.nameSource && s.nameSource.refused) why.push(s.nameSource.refused);
  const renders = s.renders
    ? (s.renders.EXACT ?? 0) + (s.renders.SOUND_SET ?? 0) + (s.renders.HEURISTIC ?? 0) : 0;
  if (renders === 0) {
    why.push(`${s.screens ?? 0} screen(s) were built and not one of them reaches a function this lane read, so nothing hangs off any of them`);
  }
  if (why.length === 0) {
    return {
      status: 'shipped',
      reason: observed === '' ? null : observed.trim(),
    };
  }
  return {
    status: 'degraded',
    reason: `we built ${s.screens ?? 0} screen(s) from ${s.declared} route declaration(s) and ${pages} page(s) a controller renders, `
      + `and part of that is not the whole picture: ${why.join('; ')}.${observed}`,
  };
}

/** Past this share of unresolved components the screen axis is degraded (RM30 §F). */
const SCREEN_UNRESOLVED_SHARE = 0.2;

/**
 * The web axis, stated from what the lane and its bridge actually did.
 *
 * @param {Object|null} web  `laneStats.web` (the worker's counts merged with the bridge's)
 * @returns {{status:string, reason:(string|null)}}
 */
function webAxis(web) {
  if (!web) {
    return {
      status: 'not-shipped',
      reason: 'the web lane did not run, because no frontend source root was given (--web-src) or found, or --no-web was passed',
    };
  }
  const resolved = web.resolved ?? null;
  const inPack = resolved ? (resolved.SOUND_SET ?? 0) + (resolved.HEURISTIC ?? 0) : 0;
  const calls = web.calls && typeof web.calls === 'object' ? (web.calls.withUrl ?? 0) : (web.callsWithUrl ?? 0);
  const untraced = web.calls && typeof web.calls === 'object' ? (web.calls.untraced ?? 0) : 0;
  // A prefix is a GUESS unless the project's own source said it. `auto` chose it
  // by counting matches; `none` means even that found nothing and the value is
  // an empty string by default. Both reshape every edge of that package, which
  // is why they and not the per-edge weaknesses decide the axis.
  const autoPrefixes = [];
  for (const [dir, p] of Object.entries(web.prefix ?? {})) {
    for (const i of p.instances ?? []) if (i.from === 'auto' || i.from === 'none') autoPrefixes.push(dir || '.');
  }
  const assumedAliases = web.assumedAliases ?? 0;
  if (resolved === null) {
    // A pack built by an engine version whose web lane only recorded facts.
    return {
      status: 'degraded',
      reason: `the web lane parsed ${web.files} file(s) and recorded ${calls} HTTP call site(s) without attaching any of them to an endpoint, `
        + 'so no frontend call is an edge in this graph',
    };
  }
  if (inPack === 0) {
    const byReason = Object.entries((web.unresolved ?? {}).byReason ?? {})
      .filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
    return {
      status: 'degraded',
      reason: `the web lane read ${calls} HTTP call site(s) and not one of them reached a route this pack serves`
        + `${byReason ? `, most often because ${byReason[0]} (${byReason[1]} call(s))` : ''}. `
        + 'Either this frontend talks to another deployable, or the prefix its calls go through is not stated anywhere we read: declare it as gatewayRoutes',
    };
  }
  // WHAT MAKES THIS AXIS DEGRADED is a guess that reshapes every edge of a
  // package: a prefix nothing in the source states, or an alias this engine
  // assumed. A call the lane could not TRACE is not one of those — it still
  // becomes an edge, graded HEURISTIC, saying so on itself — so it is named as
  // context when the axis is already degraded and never demotes it on its own.
  const why = [];
  if (autoPrefixes.length > 0) {
    const dirs = [...new Set(autoPrefixes)].sort();
    why.push(`prefix chosen by match count for ${dirs.join(', ')}: declare gatewayRoutes {"<front>": "<back>"}`);
  }
  if (assumedAliases > 0) why.push(`alias @ assumed as src, on ${assumedAliases} call(s)`);
  if (why.length === 0) return { status: 'shipped', reason: null };
  if (untraced > 0) why.push(`${untraced} call(s) untraced`);
  return {
    status: 'degraded',
    reason: `${inPack} frontend call(s) reached a route this pack serves, and part of that rested on a guess: ${why.join('; ')}. `
      + 'Every edge that rests on one is graded HEURISTIC, so a conservative answer leaves it out',
  };
}

/**
 * WHAT A SHIPPED CODE AXIS STILL COULD NOT SEE (RM35 §G).
 *
 * A shipped axis is not a perfect one, and until this round the only way the
 * pack could say so was to call the whole axis degraded — which would be a
 * bigger claim than the evidence supports and would fire on every project.
 * A `note` says the smaller true thing instead: the axis shipped, AND here is
 * the one gap in it, with what to do about it.
 *
 * The gap this returns is the only one on the code axis a reader can ACT on: a
 * wildcard import names a package of this project and no root the run analyzed
 * holds the type, so the type exists in a module nobody passed. Anything else
 * that stayed unresolved is a boundary of a parse-only lane, and the overview's
 * `unresolved-calls` gap is where those are told.
 *
 * @param {{typesOutsideRoots?:{package:string, simple:string, calls:number}[]}|null|undefined} java
 *        `pack.meta.laneStats` (the Java bridge's stats)
 * @returns {string[]}
 */
export function codeAxisNotes(java) {
  const outside = java && Array.isArray(java.typesOutsideRoots) ? java.typesOutsideRoots : [];
  // One is a single type in one package: a note that fires on one call site
  // would appear on nearly every project and stop being read.
  if (outside.length <= 1) return [];
  const packages = [...new Set(outside.map((t) => t.package))].sort();
  const calls = outside.reduce((n, t) => n + (t.calls ?? 0), 0);
  const named = packages.slice(0, CODE_NOTE_PACKAGES).join(', ');
  return [
    `${calls} call(s) name a type from ${packages.length} package(s) of this project that no analyzed source root holds `
    + `(${named}${packages.length > CODE_NOTE_PACKAGES ? `, and ${packages.length - CODE_NOTE_PACKAGES} more` : ''}). `
    + 'Those calls are counted as unresolved and are in no chain here. If the module is in this tree, pass '
    + '`--java-src <module>/src/main/java` and they resolve; if it is a dependency, they leave the project and this is where the chain really ends',
  ];
}

/** How many packages the code-axis note NAMES; the count always covers them all. */
const CODE_NOTE_PACKAGES = 5;

/**
 * The `limits` entries a declared axis map implies: one per axis that is NOT
 * shipped, plus every `note` an axis carries, in AXES order. A pack that
 * declares nothing (an older pack) yields nothing — the tool layer then falls
 * back to inferring the axis from the graph shape, as it always did.
 *
 * A NOTE IS EMITTED EVEN WHEN THE AXIS SHIPPED, which is the point of having
 * one: "the code axis is shipped" and "and here is the one thing in it we could
 * not see" are both true, and only the second is worth a sentence.
 * @param {Object|null} axes  `pack.meta.axes`
 * @returns {{scope:string, reason:string}[]}
 */
export function axisLimits(axes) {
  if (!axes || typeof axes !== 'object') return [];
  const out = [];
  for (const axis of AXES) {
    const a = axes[axis];
    if (!a) continue;
    if (a.status !== 'shipped') {
      out.push({
        scope: `axis:${axis}`,
        reason: `the ${axis} axis of this pack is ${a.status}${a.reason ? `: ${a.reason}` : ''}`,
      });
    }
    for (const note of Array.isArray(a.notes) ? a.notes : []) {
      out.push({ scope: `axis:${axis}`, reason: note });
    }
  }
  return out;
}

/**
 * The `trust.knownGaps` names a declared axis map implies — `<axis>-axis-degraded`
 * / `<axis>-axis-not-shipped`, in AXES order, so an AI reading the response can
 * name the missing axis without parsing prose.
 * @param {Object|null} axes  `pack.meta.axes`
 * @returns {string[]}
 */
export function axisKnownGaps(axes) {
  if (!axes || typeof axes !== 'object') return [];
  const out = [];
  for (const axis of AXES) {
    const a = axes[axis];
    if (!a || a.status === 'shipped') continue;
    out.push(`${axis}-axis-${a.status}`);
  }
  return out;
}

function nonEmpty(v) {
  return typeof v === 'string' && v.length > 0;
}

/**
 * A path list from a value that may be one path, several, or nothing. Blanks and
 * non-strings are dropped rather than turning into `path.resolve(cwd, undefined)`.
 * @param {string|string[]|null|undefined} v
 * @returns {string[]}
 */
function asPathList(v) {
  if (Array.isArray(v)) return v.filter(nonEmpty);
  return nonEmpty(v) ? [v] : [];
}

/**
 * THE DEFAULT DDL SET, from what discovery classified.
 *
 * The rule, in one sentence: every SCHEMA-role file written in the dialect this
 * project uses, in path order — and nothing else.
 *
 * The dialect comes from the profile when it declares one; otherwise from the
 * candidates themselves (the dialect the most schema files are written in, ties
 * broken by name so the answer does not depend on the walk). A file whose
 * dialect nothing in it reveals is portable, so it is kept whichever dialect
 * wins.
 *
 * Everything not chosen is returned WITH ITS REASON. "3 files left out" that
 * does not say which, or why, is how a wrong catalog goes unnoticed.
 *
 * @param {{path:string, dialect:(string|null), role:string}[]} candidates
 * @param {Object} profile
 * @returns {{dialect:(string|null), dialectFrom:('profile'|'files'|'none'),
 *            chosen:object[], skipped:{path:string, role:string, dialect:(string|null), reason:string}[],
 *            migrations:number, testFiles:number}}
 */
export function chooseDdlFiles(candidates, profile = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const declared = profile?.sqlDialects?.main;
  let dialect = nonEmpty(declared) ? declared : null;
  let dialectFrom = dialect ? 'profile' : 'none';
  if (!dialect) {
    const tally = new Map();
    for (const c of list) {
      if (c.role !== 'schema' || !c.dialect) continue;
      tally.set(c.dialect, (tally.get(c.dialect) ?? 0) + 1);
    }
    // A TIE IS REAL: a repository that ships its schema for MySQL AND for H2
    // has the same number of schema files in each, and the two describe the same
    // tables. Break it with the dialect the rest of the run assumes (the SQL
    // workers parse with it), so the catalog and the statements are read by the
    // same database's rules; only then fall back to the name, for determinism.
    const assumed = 'mysql';
    const ranked = [...tally.entries()].sort((a, b) => (b[1] - a[1])
      || ((b[0] === assumed ? 1 : 0) - (a[0] === assumed ? 1 : 0))
      || (a[0] < b[0] ? -1 : 1));
    if (ranked.length > 0) { [dialect] = ranked[0]; dialectFrom = 'files'; }
  }

  const chosen = [];
  const skipped = [];
  let migrations = 0;
  let testFiles = 0;
  for (const c of list) {
    // A .sql under `src/test/…` is a fixture for a test, not the schema this
    // project runs on — the same layout convention that keeps `src/test/java`
    // out of an unflagged Java lane, applied to the same kind of default.
    if (c.testPath) {
      testFiles += 1;
      skipped.push({
        path: c.path, role: c.role, dialect: c.dialect,
        reason: 'under a `src/test/` source root, so it is a test fixture rather than the schema this project runs on. Pass it with --ddl to use it anyway',
      });
      continue;
    }
    if (c.role !== 'schema') {
      migrations += 1;
      skipped.push({
        path: c.path, role: c.role, dialect: c.dialect,
        reason: c.byPath
          ? 'a migration by its path. Applying it needs the schema it amends, and its siblings in the right order'
          : c.createTables === 0
            ? `a migration by its content (it declares no table and carries ${c.alters} ALTER TABLE)`
            : `a migration by its content (${c.alters} ALTER TABLE against ${c.createTables} CREATE TABLE)`,
      });
      continue;
    }
    if (dialect && c.dialect && c.dialect !== dialect) {
      skipped.push({
        path: c.path, role: c.role, dialect: c.dialect,
        reason: `written for ${c.dialect}; this project's dialect is ${dialect} (${dialectFrom === 'profile' ? 'declared in the profile' : 'the dialect most of its schema files use'})`,
      });
      continue;
    }
    chosen.push(c);
  }
  return { dialect, dialectFrom, chosen, skipped, migrations, testFiles };
}
