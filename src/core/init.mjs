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
  if ((discovery.webPackages ?? []).length > 0) lanes.push('web');
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
 * @param {ReturnType<import('./discover.mjs').discover>} discovery
 * @param {{root:string, manifestDir:string}} opts
 * @returns {{profile:Object, diagnostics:Object[]}}
 */
export function buildProfile(discovery, opts) {
  const { root, manifestDir } = opts;
  const diagnostics = [];
  const counts = discovery.counts ?? {};
  const ddlPaths = discovery.ddlPaths ?? [];

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
  const webPackages = discovery.webPackages ?? [];
  const routerPacks = [];
  if (webPackages.length > 0) {
    frameworkPacks.push('web');
    for (const router of ['vue-router', 'react-router']) {
      if (webPackages.some((p) => p.router === router)) routerPacks.push(router);
    }
    frameworkPacks.push(...routerPacks);
  }

  let catalog = { source: 'none', connectionFrom: null };
  if (ddlPaths.length === 1) {
    catalog = { source: 'file', connectionFrom: toPosix(path.relative(manifestDir, path.resolve(root, ddlPaths[0]))) };
  } else if (ddlPaths.length > 1) {
    diagnostics.push({
      kind: 'AMBIGUOUS_CATALOG_SOURCE',
      severity: 'warn',
      path: '.',
      reason: `${ddlPaths.length} DDL files contain CREATE TABLE (${ddlPaths.join(', ')}); catalog.source is left "none". Set catalog.connectionFrom to the one that describes the live schema`,
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
        + ' It is RECORDED as catalog.connectionFrom and nothing else: run `cascade catalog fetch --yes` to pin a snapshot,'
        + ' then set catalog.source: "jdbc" yourself. Nothing connects until you do.',
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

  const profile = normalizeProfile({
    build: { tool: discovery.buildTool ?? null },
    packagePrefixes: discovery.packagePrefixes ?? [],
    sqlDialects: discovery.ddlDialectHint === 'mysql' ? { main: 'mysql' } : {},
    frameworkPacks,
    ...screenAxis,
    ...(openapiDocuments.length > 0 ? { openapi: { documents: openapiDocuments } } : {}),
    catalog,
  });
  validateProfile(profile);
  return { profile, diagnostics };
}

function toPosix(p) {
  return p.split(path.sep).join('/');
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
    fs.writeFileSync(file, JSON.stringify(content, null, 2) + '\n', 'utf8');
    written.push(file);
  }
  return { written, kept };
}

export class InitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InitError';
  }
}
