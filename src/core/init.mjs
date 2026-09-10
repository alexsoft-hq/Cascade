// init.mjs — turning a discovery into the two files a project needs (SPEC §15 M1).
//
// `cascade init` is: discover (§7.3) -> stamp identity (`manifest.json`, §6.1)
// -> stamp the reading convention (`profile.json`, §6.2) -> make the pack
// gitignored (§5.1/§17.1) -> register the project (§5).
//
// Everything here is pure except `writeInitFiles`, the single filesystem-writing
// export at the bottom. `bin/cascade.mjs` stays a thin shell over these.

import path from 'node:path';
import fs from 'node:fs';
import { MANIFEST_SCHEMA } from './manifest.mjs';
import { normalizeProfile, validateProfile } from './profile.mjs';
import { ROUTER_PACKS } from './discover.mjs';
import { DEFAULT_PORTS } from './dbconfig.mjs';
import { chooseCatalogVendor, groupDdlByVendor } from './lanes.mjs';

const ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * A filesystem- and id-safe project id from an arbitrary directory name:
 * lower-cased, everything outside `[a-z0-9._-]` folded to `-`, leading junk
 * dropped. Returns null when nothing usable is left (the caller must then ask
 * for `--project`, rather than invent a name).
 * @param {string} name
 * @returns {string|null}
 */
export function slugify(name) {
  if (typeof name !== 'string') return null;
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-+$/, '');
  return ID_RE.test(slug) ? slug : null;
}

/**
 * The lanes the engine could actually run on this tree, in engine order.
 * @param {{counts:Object}} discovery
 * @returns {string[]}
 */
export function lanesOf(discovery) {
  const c = discovery.counts ?? {};
  const lanes = [];
  if ((c.ddlFiles ?? 0) > 0 || (c.mybatisMapperXml ?? 0) > 0) lanes.push('sql');
  if ((c.javaFiles ?? 0) > 0) lanes.push('java');
  // The web lane runs over a frontend PACKAGE, not over loose `.js` files: a
  // build script at the top of a Java repository is not a frontend, and reading
  // it would put a lane on the list that has nothing to say.
  // A frontend with no package manifest is a lane too (RM47): the files are
  // there and the tree says the server serves them.
  if ((discovery.webPackages ?? []).length > 0 || (discovery.webVendoredRoots ?? []).length > 0) lanes.push('web');
  return lanes;
}

/**
 * Build the `manifest.json` content (SPEC §6.1). Repository paths are relative
 * to the MANIFEST FILE'S directory (§5) — so the scanned root, which holds
 * `.cascade/`, comes out as "..".
 *
 * `kind`: `backend-java` when the repo holds java sources, `frontend-web` when
 * it only holds a frontend package.json, `unknown` otherwise — the engine never
 * pretends to know a stack it did not see.
 *
 * @param {ReturnType<import('./discover.mjs').discover>} discovery
 * @param {{projectId:string, root:string, manifestDir:string}} opts
 * @returns {{schema:string, project:string, repositories:Object[], profile:string}}
 */
export function buildManifest(discovery, opts) {
  const { projectId, root, manifestDir } = opts;
  if (!ID_RE.test(projectId ?? '')) {
    throw new InitError(`project id ${JSON.stringify(projectId)} must match ${ID_RE}. Pass --project <id>`);
  }
  const repos = discovery.repos ?? [];
  if (repos.length === 0) {
    throw new InitError(
      `no git repository with a HEAD commit found under ${root}. Cascade pins every analysis to a full commit, so run \`git init && git commit\` first, or point --root at a checkout`,
    );
  }
  const usedKeys = new Set();
  const repositories = repos.map((repo) => {
    const abs = path.resolve(root, repo.path === '.' ? '.' : repo.path);
    const rel = toPosix(path.relative(manifestDir, abs)) || '.';
    const base = repo.path === '.' ? projectId : (slugify(repo.path.split('/').join('-')) ?? 'repo');
    let key = base;
    for (let i = 2; usedKeys.has(key); i += 1) key = `${base}-${i}`;
    usedKeys.add(key);
    return {
      key,
      path: rel,
      commit: repo.commit,
      kind: (repo.javaFiles ?? 0) > 0
        ? 'backend-java'
        : (repo.frontendPackageJson ?? 0) > 0 ? 'frontend-web' : 'unknown',
    };
  });
  return {
    schema: MANIFEST_SCHEMA,
    project: projectId,
    repositories,
    profile: './profile.json',
  };
}

/**
 * Build the `profile.json` content (SPEC §6.2) from the discovery hints, and the
 * diagnostics the choice produced. Everything not measured is left at its
 * documented default — in particular `schema.default` stays null (invariant I-4).
 *
 * `catalog` is wired to the DDL file only when there is exactly ONE; several
 * candidates are reported and left for the user, because picking one silently
 * would decide the project's schema for them. With no DDL at all, a single
 * connection-info file (application.yml, .env, …) is RECORDED in
 * `catalog.connectionFrom` — but `catalog.source` stays "none", so nothing
 * connects until the user says so (SPEC §12.3).
 *
 * THREE KEYS ARE THE USER'S THE MOMENT THEY EXIST: `gatewayRoutes`,
 * `serviceNames` and `webRoots`. Discovery reads all three out of the tree
 * (RM46, RM47), and each is written only into a profile that has none. A map
 * somebody typed outranks a re-run of discovery, so a non-empty one is left
 * exactly as it is and the diagnostic says what was found and not applied.
 *
 * @param {ReturnType<import('./discover.mjs').discover>} discovery
 * @param {{root:string, manifestDir:string, existing?:(Object|null)}} opts
 *        `existing` is the profile already on disk, when there is one.
 * @returns {{profile:Object, diagnostics:Object[]}}
 */
/**
 * WHICH FRAMEWORK PACKS THIS TREE DECLARES. A pack is what turns a file
 * discovery found into a lane that runs, so this is the profile's answer to
 * "which lanes does this project want?" — and a router package is the SCREEN
 * AXIS switch, which is why the router packs come back beside them.
 */
function declareFrameworkPacks(discovery, counts) {
const frameworkPacks = [];
if ((counts.springHandlerFiles ?? 0) > 0) frameworkPacks.push('spring-mvc');
if ((counts.mybatisMapperXml ?? 0) > 0) frameworkPacks.push('mybatis-xml');
// @Entity classes mean the persistence this project actually uses is declared
// in the mapping, not written as SQL — that is the `jpa` pack's lane (M10).
if ((counts.jpaEntityFiles ?? 0) > 0) frameworkPacks.push('jpa');
// `extends BaseMapper<…>` or `@TableName` means MyBatis-Plus generates the
// CRUD this project never wrote — that is the `mybatis-plus` pack's lane
// (RM15). It is INDEPENDENT of mybatis-xml: a project can have both, and
// jeecg-boot does (80 mapper XML files for 65 mappers, and generic CRUD for
// everything else).
if ((counts.mybatisPlusFiles ?? 0) > 0) frameworkPacks.push('mybatis-plus');
// A frontend package means there is a screen side to this project, and the
// web lane reads it (RM26). The ROUTER packs are declared only when a package
// depends on one: the router declaration packs (adapters/web/packs) are what
// let the worker recognize a route object, and naming the one this project
// actually uses is how the profile says which convention its screens follow.
//
// A VENDORED ROOT COUNTS THE SAME WAY (RM47). A gateway that ships AngularJS
// as `<script>` tags has no manifest to read a dependency out of, so the
// router pack comes from the registrar its own source writes. Everything else
// about the lane is identical: the same worker reads the same files.
const webPackages = discovery.webPackages ?? [];
const vendoredRoots = discovery.webVendoredRoots ?? [];
const routerPacks = [];
if (webPackages.length > 0 || vendoredRoots.length > 0) {
  frameworkPacks.push('web');
  for (const router of ROUTER_PACKS) {
    if (webPackages.some((p) => p.router === router)
      || vendoredRoots.some((r) => (r.routerPacks ?? []).includes(router))) routerPacks.push(router);
  }
  frameworkPacks.push(...routerPacks);
}

  return { frameworkPacks, routerPacks, vendoredRoots };
}

/**
 * WHICH DATABASE THIS PROJECT RUNS ON, when the tree ships more than one
 * vendor's schema — and the dialect the profile is written with.
 *
 * `main` is what goes into `sqlDialects.main`. Two things can put a value
 * there and they rank in this order: a vendor the project NAMES (RM55, the
 * `Globals.DbType` eGovFrame writes, or a jdbc url every connection file
 * agrees on), and the MySQL marker discovery reads out of the DDL text itself,
 * which is the rule that was here before and still answers for every
 * single-vendor repository.
 */
function declareDialect(discovery, { existing }) {
  const vendors = groupDdlByVendor(discovery.ddlCandidates ?? []);
  const chosen = vendors.size > 1
    ? chooseCatalogVendor({
      vendors: [...vendors.keys()],
      profileDialect: existing?.sqlDialects?.main ?? null,
      dbTypes: discovery.dbTypeDeclarations ?? [],
      connections: discovery.connectionCandidates ?? [],
    })
    : { vendor: null, from: 'none', why: 'this tree ships one vendor\'s schema, so there is nothing to choose', at: null };
  const main = chosen.vendor ?? (discovery.ddlDialectHint === 'mysql' ? 'mysql' : null);
  return { ...chosen, vendors, main };
}

/**
 * WHERE THE SCHEMA IS. One DDL file in the tree is the catalog; no DDL and one
 * connection candidate RECORDS where the database is and leaves the source at
 * `none`, because reading a live database is a sentence the user types.
 */
/**
 * ONE SCHEMA, SHIPPED ONCE PER DATABASE VENDOR (RM55).
 *
 * Every eGovFrame project keeps
 * `DATABASE/{oracle,mysql,tibero,cubrid,postgres,altibase,goldilocks}/`, and
 * reading all seven is not a fuller catalog: measured on
 * egovframe-common-components, it declared 182 tables eight times over and
 * raised 13,505 duplicate-declaration warnings. When the project's own
 * configuration says which database it runs on, that vendor's files ARE the
 * schema and the rest are recorded as alternatives to swap in.
 *
 * @returns {Object|null} the catalog block, or null when nothing here decides
 */
function vendorCatalog(dialect, { root, manifestDir, diagnostics }) {
  const byVendor = dialect.vendors;
  const chosen = dialect.vendor === null ? [] : (byVendor.get(dialect.vendor) ?? []);
  if (byVendor.size <= 1 || chosen.length === 0) return null;
  const rel = (p) => toPosix(path.relative(manifestDir, path.resolve(root, p)));
  const others = [...byVendor.entries()].filter(([v]) => v !== dialect.vendor);
  diagnostics.push({
    kind: 'CATALOG_VENDOR_CHOSEN',
    severity: 'info',
    path: '.',
    reason: `this tree ships its schema for ${byVendor.size} databases (${[...byVendor.keys()].join(', ')}); `
      + `catalog.ddl is the ${dialect.vendor} set (${chosen.length} file(s)), because ${dialect.why}. `
      + 'The others are recorded as catalog.ddlAlternatives: swap one into catalog.ddl to read that vendor instead',
  });
  return {
    source: 'file',
    connectionFrom: null,
    ddl: chosen.map(rel),
    ddlAlternatives: Object.fromEntries(others.map(([v, files]) => [v, files.map(rel)])),
  };
}

function declareCatalog(discovery, { ddlPaths, root, manifestDir, diagnostics, dialect }) {
const byVendor = dialect.vendors;
let catalog = vendorCatalog(dialect, { root, manifestDir, diagnostics }) ?? { source: 'none', connectionFrom: null };
if (catalog.source === 'file') {
  // decided by vendor above
} else if (ddlPaths.length === 1) {
  catalog = { source: 'file', connectionFrom: toPosix(path.relative(manifestDir, path.resolve(root, ddlPaths[0]))) };
} else if (ddlPaths.length > 1) {
  diagnostics.push({
    kind: 'AMBIGUOUS_CATALOG_SOURCE',
    severity: 'warn',
    path: '.',
    reason: `${ddlPaths.length} DDL files contain CREATE TABLE (${ddlPaths.join(', ')}); catalog.source is left "none". `
      + (byVendor.size > 1
        ? `They are one schema written for ${byVendor.size} databases (${[...byVendor.keys()].join(', ')}), and ${dialect.why}, `
          + 'so nothing here can say which of them is this project\'s. Set catalog.ddl to that vendor\'s files'
        : 'Set catalog.connectionFrom to the one that describes the live schema'),
  });
}

// No DDL in the tree, but the project says where its database is? RECORD the
// file — and stop there. `source` stays "none": SPEC §12.3 forbids the tool
// deciding by itself to connect anywhere, precisely because the connection
// info comes from the ANALYZED REPOSITORY, which is untrusted input (§17.5).
// Turning it on is a sentence the user types, and the diagnostic below is
// where they read it.
const candidates = discovery.connectionCandidates ?? [];
if (catalog.source === 'none' && candidates.length === 1) {
  const only = candidates[0];
  catalog = {
    source: 'none',
    connectionFrom: toPosix(path.relative(manifestDir, path.resolve(root, only.path))),
  };
  diagnostics.push({
    kind: 'CATALOG_CONNECTION_FOUND',
    severity: 'info',
    path: only.path,
    reason: `${only.path} describes a ${only.dialect ?? 'database'} at ${only.host ?? '?'}:${only.port ?? '?'}/${only.database ?? '?'}`
      + ` (user ${only.usernameRef ?? 'not stated'}, password ${only.passwordPresent ? 'present in that file' : 'absent'}).`
      + ' It is RECORDED as catalog.connectionFrom and nothing else: run `cascade catalog fetch --candidate 1` to see the exact target,'
      + ' confirm it, and pin a snapshot the profile then reads. Nothing connects until you do.',
  });
} else if (catalog.source === 'none' && candidates.length > 1) {
  diagnostics.push({
    kind: 'AMBIGUOUS_CATALOG_SOURCE',
    severity: 'info',
    path: '.',
    reason: `${candidates.length} files carry datasource connection info (${candidates.slice(0, 4).map((c) => c.path).join(', ')}${candidates.length > 4 ? ', …' : ''});`
      + ' none is recorded, because picking one would decide which database this project talks to.'
      + ' Run `cascade catalog discover` to list them.',
  });
}

// The OpenAPI / Swagger documents this tree ships, MANIFEST-RELATIVE like
// every other path in the profile. They are recorded whatever else was found:
// reading a document needs no framework pack, and a project that publishes one
// has already said what it serves.
const openapiDocuments = (discovery.openapiDocuments ?? [])
  .map((d) => toPosix(path.relative(manifestDir, path.resolve(root, d.path))))
  .sort();

  return { catalog, openapiDocuments };
}

/**
 * THE FRONTEND AND TEMPLATE ROOTS no package manifest declares (RM47, RM48),
 * written down so a later run reads them from the profile rather than
 * rediscovering them — and a root the USER wrote stays the user's.
 */
function declareWebRoots(discovery, { existing, routerPacks, vendoredRoots, root, manifestDir, diagnostics }) {
// A ROUTER PACK IS THE SCREEN AXIS SWITCH. The packs are what let the worker
// recognize a route object at all, so a project that uses one has screens to
// build and the axis is turned on here rather than left for the reader to
// find.
//
// A project with no router package IN THIS TREE leaves the key at its default
// (null), which is NOT "off": discovery walked the analyzed root, and a
// backend whose frontend is checked out beside it has no package here to
// find. `screenAxisOf` (src/core/lanes.mjs) decides that case from what the
// run really reads. Writing `false` here would be this engine putting words
// in the user's mouth, and those words would be wrong.
const screenAxis = routerPacks.length > 0 ? { screenAxis: { enabled: true } } : {};

// THE FRONTEND ROOTS NO PACKAGE DECLARES, written down so a later run reads
// them without a flag. Same rule as the two keys below: a list that is
// already in the profile is the user's word, including an EMPTY one, which is
// how a project says "read none of them". Discovery re-running is not a
// reason to overwrite either answer.
const discoveredWebRoots = vendoredRoots.map((r) => ({
  root: toPosix(path.relative(manifestDir, path.resolve(root, r.root))),
  kind: 'vendored',
  from: 'discovery',
}));
const declaredWebRoots = Array.isArray(existing?.webRoots) ? existing.webRoots : null;
const webRoots = declaredWebRoots ?? discoveredWebRoots;
if (declaredWebRoots !== null && discoveredWebRoots.length > 0) {
  diagnostics.push({
    kind: 'WEB_ROOTS_KEPT',
    severity: 'info',
    path: '.',
    reason: `the profile already answers for webRoots (${declaredWebRoots.length} root(s)), so it is left alone. `
      + `This tree holds ${discoveredWebRoots.length} frontend root(s) with no package manifest that were not applied: `
      + `${vendoredRoots.map((r) => r.root).join(', ')}`,
  });
}

// WHERE A VIEW NAME BECOMES A PAGE (RM48). Same rule again: written only into
// a profile that has no list of its own, because a template root decides what
// is in the pack and a pack must not change under an input nobody recorded.
const discoveredTemplateRoots = (discovery.templateRoots ?? []).map((r) => ({
  root: toPosix(path.relative(manifestDir, path.resolve(root, r.root))),
  engine: r.engine,
  suffix: r.suffix,
  from: r.from,
}));
const declaredTemplateRoots = Array.isArray(existing?.templateRoots) ? existing.templateRoots : null;
const templateRoots = declaredTemplateRoots ?? discoveredTemplateRoots;
if (declaredTemplateRoots !== null && discoveredTemplateRoots.length > 0) {
  diagnostics.push({
    kind: 'TEMPLATE_ROOTS_KEPT',
    severity: 'info',
    path: '.',
    reason: `the profile already answers for templateRoots (${declaredTemplateRoots.length} root(s)), so it is left alone. `
      + `This tree holds ${discoveredTemplateRoots.length} template root(s) that were not applied: `
      + `${discoveredTemplateRoots.map((r) => `${r.root} (${r.engine})`).join(', ')}`,
  });
}

  return { screenAxis, webRoots, templateRoots };
}

/**
 * WHO THIS SERVICE IS and WHERE IT FORWARDS (RM46), read from its own Spring
 * configuration. Both used to be typed into the profile by hand, and both are in
 * the tree; a value the user wrote is kept, and the difference is reported.
 */
function declareServiceIdentity(discovery, { existing, diagnostics }) {
// WHO THIS SERVICE IS, from `spring.application.name` (RM46). It is what the
// federation matcher uses to pick one sibling out of several serving the same
// path, so leaving it for a person to type was leaving the tie-breaker unset
// on every project that never edits its profile.
const discoveredNames = [...new Set((discovery.serviceNames ?? []).map((s) => s.name))].sort();
const declaredNames = Array.isArray(existing?.serviceNames) ? existing.serviceNames.filter((s) => typeof s === 'string' && s !== '') : [];
const serviceNames = declaredNames.length > 0 ? declaredNames : discoveredNames;
if (declaredNames.length > 0 && discoveredNames.some((n) => !declaredNames.includes(n))) {
  diagnostics.push({
    kind: 'SERVICE_NAME_KEPT',
    severity: 'info',
    path: '.',
    reason: `the profile already names this project ${declaredNames.join(', ')}, so it is left alone. `
      + `This tree also declares spring.application.name ${discoveredNames.join(', ')}`,
  });
}

// WHERE THIS GATEWAY FORWARDS, from its own `spring.cloud.gateway` route
// table (RM46). Same rule as the name: written only into a profile that has
// no map of its own.
const discoveredRoutes = {};
for (const r of discovery.gatewayRoutes ?? []) {
  if (Object.hasOwn(discoveredRoutes, r.front)) {
    const already = discoveredRoutes[r.front];
    if (already.to !== r.to || already.service !== r.service) {
      diagnostics.push({
        kind: 'AMBIGUOUS_GATEWAY_ROUTE',
        severity: 'warn',
        path: r.file,
        reason: `two gateway routes claim the prefix ${r.front} and forward it differently `
          + `(${already.from} sends it to ${already.service ?? 'an unnamed service'} as ${already.to || '/'}, `
          + `${r.file} to ${r.service ?? 'an unnamed service'} as ${r.to || '/'}); the first one is kept`,
      });
    }
    continue;
  }
  discoveredRoutes[r.front] = { to: r.to, service: r.service, from: r.file };
}
const declaredRoutes = existing && typeof existing.gatewayRoutes === 'object' && existing.gatewayRoutes !== null
  ? existing.gatewayRoutes : {};
const keepRoutes = Object.keys(declaredRoutes).length > 0;
const gatewayRoutes = keepRoutes ? declaredRoutes : discoveredRoutes;
if (keepRoutes && Object.keys(discoveredRoutes).length > 0) {
  diagnostics.push({
    kind: 'GATEWAY_ROUTES_KEPT',
    severity: 'info',
    path: '.',
    reason: `the profile already declares ${Object.keys(declaredRoutes).length} gateway route(s), so they are left alone. `
      + `This tree declares ${Object.keys(discoveredRoutes).length} route(s) that were not applied: `
      + `${Object.keys(discoveredRoutes).sort().join(', ')}`,
  });
}

  return { serviceNames, gatewayRoutes };
}


export function buildProfile(discovery, opts) {
  const { root, manifestDir } = opts;
  const existing = opts.existing && typeof opts.existing === 'object' && !Array.isArray(opts.existing)
    ? opts.existing : null;
  const diagnostics = [];
  const counts = discovery.counts ?? {};
  const ddlPaths = discovery.ddlPaths ?? [];

  const { frameworkPacks, routerPacks, vendoredRoots } = declareFrameworkPacks(discovery, counts);
  const dialect = declareDialect(discovery, { existing });
  const { catalog, openapiDocuments } = declareCatalog(discovery, {
    ddlPaths, root, manifestDir, diagnostics, dialect,
  });
  const { screenAxis, webRoots, templateRoots } = declareWebRoots(discovery, {
    existing, routerPacks, vendoredRoots, root, manifestDir, diagnostics,
  });
  const { serviceNames, gatewayRoutes } = declareServiceIdentity(discovery, { existing, diagnostics });


  const profile = normalizeProfile({
    build: { tool: discovery.buildTool ?? null },
    packagePrefixes: discovery.packagePrefixes ?? [],
    sqlDialects: dialect.main === null ? {} : { main: dialect.main },
    frameworkPacks,
    ...screenAxis,
    ...(webRoots.length > 0 ? { webRoots } : {}),
    ...(templateRoots.length > 0 ? { templateRoots } : {}),
    ...(serviceNames.length > 0 ? { serviceNames } : {}),
    ...(Object.keys(gatewayRoutes).length > 0 ? { gatewayRoutes } : {}),
    ...(openapiDocuments.length > 0 ? { openapi: { documents: openapiDocuments } } : {}),
    catalog,
  });
  validateProfile(profile);
  return { profile, diagnostics };
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

/**
 * THE SIGNPOST. A project with no schema is the one gap that changes what every
 * later answer looks like, and it used to be reported as a single info line
 * among a dozen. This is the block `cascade init` ends with instead: what is
 * missing, what it costs, and the three ways forward with the command for each.
 *
 * Pure: it returns text. The caller prints it, and decides whether to offer the
 * interactive hand-off underneath.
 *
 * @param {{candidates?:Object[], profilePath?:string|null}} a
 *        `candidates` are discovery's connection candidates, in the order
 *        `cascade catalog discover` numbers them (so `--candidate n` here means
 *        the same thing there). `profilePath` is shown in the "make it
 *        permanent" line, and may be null.
 * @returns {string} the block, ending in a newline
 */
export function catalogSignpost(a = {}) {
  const candidates = Array.isArray(a.candidates) ? a.candidates : [];
  const profilePath = a.profilePath ?? '.cascade/profile.json';
  const rule = '-'.repeat(72);
  const out = [];
  out.push(rule);
  out.push('NO DATABASE SCHEMA IN THIS TREE');
  out.push(rule);
  out.push('No .sql file here declares CREATE TABLE and no schema has been fetched,');
  out.push('so catalog.source stays "none". Analysis still runs. Three things it');
  out.push('cannot do without a schema:');
  out.push('');
  out.push('  1. draw a single relationship line on the ERD. A join names two');
  out.push('     columns, and with no catalog neither one can be attributed to a');
  out.push('     table, so the diagram comes back as tables with nothing between them.');
  out.push('  2. expand SELECT * into the columns it really reads.');
  out.push('  3. answer a column question in full. A bare column name is tied to its');
  out.push('     table only where the SQL says so unambiguously, and what cannot be');
  out.push('     tied is recorded as unresolved rather than guessed.');
  out.push('');
  out.push('Three ways forward. Pick one.');
  out.push('');
  out.push('  1. You already have a schema file');
  out.push('       cascade analyze --ddl path/to/schema.sql');
  out.push(`     To make that the standing answer, put this in ${profilePath}:`);
  out.push('       "catalog": { "source": "file", "connectionFrom": "path/to/schema.sql" }');
  out.push('');
  if (candidates.length > 0) {
    out.push('  2. Read the schema from the database this project already names');
    candidates.forEach((c, i) => {
      out.push(`       [${i + 1}] ${candidateLine(c)}`);
      out.push(`           read from ${c.path}`);
    });
    out.push(`       cascade catalog fetch --candidate ${candidates.length === 1 ? '1' : '<n>'}`);
    out.push('     It prints the exact target and asks before it connects. The password');
    out.push('     comes from your credentials file, from CASCADE_DB_PASSWORD, or from a');
    out.push('     hidden prompt. No password is read out of the file above.');
  } else {
    out.push('  2. Read the schema from a database');
    out.push('     Nothing in this tree names a datasource, so there is no candidate to');
    out.push('     point at. Name the target yourself:');
    out.push('       cascade catalog fetch --url jdbc:mysql://your-host:3306/your-db --user <user>');
  }
  out.push('');
  out.push('  3. Decide later');
  out.push('       cascade estimate');
  out.push('     says what a run will and will not ship, and keeps saying this one is');
  out.push('     missing until a schema is here.');
  out.push(rule);
  return out.join('\n') + '\n';
}

/**
 * One candidate, as the signpost shows it: dialect, host, port, database and
 * user. NEVER the password, and never whether one is in the file: the signpost
 * is about the schema, and the password question belongs to `fetch`.
 * @param {Object} c
 * @returns {string}
 */
function candidateLine(c) {
  const port = c.port ?? (c.dialect ? DEFAULT_PORTS[c.dialect] ?? null : null);
  const target = `${c.dialect ?? 'unknown-dialect'} ${c.host ?? '?'}:${port ?? '?'}/${c.database ?? '?'}`;
  const user = c.usernameRef && !/^\$\{/.test(c.usernameRef) ? c.usernameRef : null;
  return `${target} as ${user ? `user ${user}` : 'a user this file does not state'}`;
}

// ---------------------------------------------------------------------------
// Filesystem edge. Everything above is pure.
// ---------------------------------------------------------------------------

/**
 * FILESYSTEM-WRITING export (the only one). Write `manifest.json` and
 * `profile.json` into an already-created `.cascade/` directory. An existing file
 * is KEPT, never overwritten, unless `force` — the user's hand edits outrank a
 * re-run of discovery.
 *
 * @param {{manifestPath:string, profilePath:string, manifest:Object, profile:Object, force?:boolean}} args
 * @returns {{written:string[], kept:string[]}}
 */
export function writeInitFiles(args) {
  const { manifestPath, profilePath, manifest, profile } = args;
  const force = args.force === true;
  const written = [];
  const kept = [];
  for (const [file, content] of [[manifestPath, manifest], [profilePath, profile]]) {
    if (fs.existsSync(file) && !force) {
      kept.push(file);
      continue;
    }
    writeStateFile(file, content);
    written.push(file);
  }
  return { written, kept };
}

/**
 * Write one `.cascade/` state document. The single place the bytes are decided
 * (two-space JSON, one trailing newline), so a profile `cascade catalog fetch`
 * edits comes out looking exactly like the one `cascade init` wrote rather than
 * as a diff nobody asked for.
 * @param {string} file
 * @param {Object} content
 */
export function writeStateFile(file, content) {
  fs.writeFileSync(file, JSON.stringify(content, null, 2) + '\n', 'utf8');
}

export class InitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InitError';
  }
}
