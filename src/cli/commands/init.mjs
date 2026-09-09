// init.mjs — `cascade init`: discover the tree, write the project's own state,
// and register it.
//
// discover -> manifest + profile -> .gitignore -> registry, in that order, and
// the census it prints is the point as much as the files are: what was found,
// what was assumed, and what a reader has to decide for themselves.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { discover } from '../../core/discover.mjs';
import { buildManifest, buildProfile, writeInitFiles, catalogSignpost, lanesOf, slugify } from '../../core/init.mjs';
import { validateManifest } from '../../core/manifest.mjs';
import { ensureProjectDirs, projectPaths, registryPath } from '../../core/paths.mjs';
import { readRegistry, upsertProject, writeRegistryAtomic } from '../../core/registry.mjs';
import { CLI_PATH, DISCOVER_IO, realPath } from '../env.mjs';
import { listOfFive } from '../output.mjs';
import { promptLine } from '../tty.mjs';

/** The project's own state: the manifest and the profile that discovery feeds. */
function buildProjectFiles({ die }, discovery, { projectId, root, p, force }) {
  // THE PROFILE THAT IS ALREADY THERE, when there is one. Two keys are the
  // user's word the moment they exist (`gatewayRoutes`, `serviceNames`), so a
  // re-run with --force must not overwrite them with what discovery read.
  let existingProfile = null;
  if (fs.existsSync(p.profile)) {
    try { existingProfile = JSON.parse(fs.readFileSync(p.profile, 'utf8')); }
    catch (e) { process.stderr.write(`the profile at ${p.profile} could not be read (${e.message}), so this run treats it as absent\n`); }
  }
  let manifest;
  let profile;
  let profileDiagnostics = [];
  try {
    manifest = buildManifest(discovery, { projectId, root, manifestDir: p.root });
    validateManifest(manifest, p.manifest);
    const built = buildProfile(discovery, { root, manifestDir: p.root, existing: existingProfile });
    profile = built.profile;
    profileDiagnostics = built.diagnostics;
  } catch (e) {
    die(e.message);
  }
  ensureProjectDirs(root);
  const { written, kept } = writeInitFiles({
    manifestPath: p.manifest, profilePath: p.profile, manifest, profile, force,
  });
  return { profile, diagnostics: [...discovery.diagnostics, ...profileDiagnostics], written, kept };
}

/**
 * What discovery read, said out loud. A run that scanned a tree and printed
 * nothing about it is a run nobody can check: every line here is a number a
 * reader can compare against what they know is in their own repository.
 */
function printDiscovery(discovery, { projectId, root, lanes, diagnostics }) {
  const c = discovery.counts;
  process.stderr.write(`project ${projectId} at ${root}\n`);
  process.stderr.write(`repositories (${discovery.repos.length}): ${discovery.repos.map((r) => `${r.path}@${r.commit.slice(0, 8)}`).join(', ')}\n`);
  process.stderr.write(`files scanned ${discovery.filesScanned}${discovery.capped ? ' (CAPPED: see diagnostics)' : ''}: `
    + `${c.javaFiles} java (${c.springHandlerFiles} spring handlers, ${c.jpaEntityFiles} JPA entities), `
    + `${c.mybatisMapperXml} mybatis mapper xml, ${c.ddlFiles} DDL, ${c.kotlinFiles} kotlin, ${c.frontendPackageJson} frontend package.json\n`);
  process.stderr.write(`build tool ${discovery.buildTool ?? 'none detected'}; package prefixes [${discovery.packagePrefixes.join(', ')}]; lanes [${lanes.join(',')}]\n`);
  // WHO THIS SERVICE IS AND WHERE IT FORWARDS, read out of the tree (RM46).
  // Both used to be blanks a person filled in, and both decide whether an
  // answer can cross from this project into the next one.
  for (const s of discovery.serviceNames ?? []) {
    process.stderr.write(`service name: ${s.name} (from ${s.file})\n`);
  }
  // A FRONTEND WITH NO PACKAGE MANIFEST, said in one line (RM47). It is the one
  // thing about this profile a reader would not expect, and the way to turn it
  // off is in the same sentence as the way it was turned on.
  // ONE LINE, however many roots. A tree with a directory of vendored plugin
  // scripts has thirteen of them, and thirteen lines saying the same thing is a
  // wall a reader skips rather than a finding.
  const vendoredKept = diagnostics.some((d) => d.kind === 'WEB_ROOTS_KEPT');
  const vendored = discovery.webVendoredRoots ?? [];
  if (vendored.length > 0) {
    const named = [...new Set(vendored.flatMap((r) => r.routerPacks ?? []))].sort();
    const files = vendored.reduce((n, r) => n + r.files, 0);
    process.stderr.write(`frontend without a package: reading ${listOfFive(vendored.map((r) => r.root))} `
      + `(${vendored.length} root(s), ${files} file(s)`
      + `${named.length > 0 ? `, router ${named.join(', ')}` : ', no router declaration in any of them'})`
      + `${vendoredKept ? '. The profile already answers for webRoots, so these were not applied' : '. Set webRoots to [] in the profile to stop'}\n`);
  }
  // WHERE A VIEW NAME BECOMES A PAGE (RM48). One line, however many roots, with
  // the engine and the suffix on each: a root nobody recorded is why a
  // `@Controller` would come out with no screen.
  const templateRoots = discovery.templateRoots ?? [];
  if (templateRoots.length > 0) {
    const templatesKept = diagnostics.some((d) => d.kind === 'TEMPLATE_ROOTS_KEPT');
    const froms = [...new Set(templateRoots.map((r) => r.from))].sort();
    process.stderr.write(`template roots: ${templateRoots.length} (${froms.join(', ')}) `
      + `${listOfFive(templateRoots.map((r) => `${r.root} ${r.engine} ${r.suffix}`))}`
      + `${templatesKept ? '. The profile already answers for templateRoots, so these were not applied' : '. Set templateRoots to [] in the profile to stop'}
`);
  }
  const routeFiles = [...new Set((discovery.gatewayRoutes ?? []).map((r) => r.file))].sort();
  if (routeFiles.length > 0) {
    const routesKept = diagnostics.some((d) => d.kind === 'GATEWAY_ROUTES_KEPT');
    process.stderr.write(`gateway routes: ${discovery.gatewayRoutes.length} read from ${routeFiles.join(', ')}`
      + `${routesKept ? ' (the profile already declares its own, so these were not applied)' : ''}\n`);
    for (const r of discovery.gatewayRoutes) {
      process.stderr.write(`  ${r.front} -> ${r.to === '' ? '/' : r.to} at ${r.service ?? 'a service this route does not name'}\n`);
    }
  }
}

/** What was written, what was kept, and every diagnostic, grouped by kind. */
function printFiles({ written, kept, projectId, dotCascade, regFile, diagnostics }) {
  for (const f of written) process.stderr.write(`wrote ${f}\n`);
  for (const f of kept) process.stderr.write(`kept ${f} (already present: re-run with --force to overwrite)\n`);
  process.stderr.write(`registered ${projectId} -> ${dotCascade} in ${regFile}\n`);
  if (diagnostics.length === 0) {
    process.stderr.write('diagnostics: none\n');
  } else {
    const byKind = new Map();
    for (const d of diagnostics) byKind.set(d.kind, (byKind.get(d.kind) ?? 0) + 1);
    process.stderr.write(`diagnostics (${diagnostics.length}): ${[...byKind].map(([k, n]) => `${k} x${n}`).join(', ')}\n`);
    for (const d of diagnostics.slice(0, 5)) process.stderr.write(`  [${d.severity}] ${d.kind} ${d.path}: ${d.reason}\n`);
    if (diagnostics.length > 5) process.stderr.write(`  … ${diagnostics.length - 5} more (see --json for all of them)\n`);
  }
}

/**
 * THE SIGNPOST, last, so it is the thing still on screen. A missing schema is
 * not one diagnostic among a dozen: it decides whether the ERD has any lines in
 * it and whether a column question can be answered in full, and the reader has
 * to meet that here rather than three commands later.
 */
function printSignpost(discovery, profile, { root, profilePath }) {
  const noDdl = (discovery.ddlPaths ?? []).length === 0;
  if (!noDdl || (profile.catalog?.source ?? 'none') !== 'none') return;
  const candidates = discovery.connectionCandidates ?? [];
  process.stderr.write('\n' + catalogSignpost({ candidates, profilePath }));
  // In a terminal the reader can act on it now instead of retyping a command
  // they just read. Outside one (a script, CI, a pipe) the block IS the answer:
  // nothing prompts, nothing connects.
  if (candidates.length === 0 || !process.stdin.isTTY) return;
  const pick = promptLine(`\nFetch one of these now? Enter 1-${candidates.length}, or press Enter to skip: `);
  const n = Number(pick.trim());
  if (!Number.isInteger(n) || n < 1 || n > candidates.length) return;
  // The hand-off is literal: the same command the block printed, run with this
  // terminal attached, so its own confirmation and its own hidden password
  // prompt are the ones the reader answers.
  try {
    execFileSync(process.execPath, [CLI_PATH, 'catalog', 'fetch', '--root', root, '--candidate', String(n)], { stdio: 'inherit' });
  } catch {
    process.stderr.write(`\nthe fetch did not finish. \`cascade catalog fetch --candidate ${n}\` runs it again when you are ready.\n`);
  }
}

export function run(ctx) {
  const { opt, flag, die } = ctx;
  // discover -> manifest + profile -> .gitignore -> registry (SPEC §15 M1).
  const root = path.resolve(opt('root', process.cwd()));
  const force = flag('force');
  const asJson = flag('json');
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) die(`--root ${root} is not a directory`);
  const projectId = opt('project') ?? slugify(path.basename(root));
  if (!projectId) die(`cannot derive a project id from ${JSON.stringify(path.basename(root))}. Pass --project <id> (lower-case, [a-z0-9._-])`);

  const discovery = discover(root, DISCOVER_IO);
  const p = projectPaths(root);
  const { profile, diagnostics, written, kept } = buildProjectFiles(ctx, discovery, { projectId, root, p, force });

  const lanes = lanesOf(discovery);
  const regFile = registryPath(process.env);
  try {
    writeRegistryAtomic(regFile, upsertProject(readRegistry(regFile), {
      id: projectId, dotCascadePath: realPath(p.root), source: 'init', stack: lanes, lastCertifiedAt: null,
    }, { force }));
  } catch (e) {
    die(`${e.message}\n  (nothing was written to ${regFile}; the project files above are in place)`);
  }

  printDiscovery(discovery, { projectId, root, lanes, diagnostics });
  printFiles({ written, kept, projectId, dotCascade: p.root, regFile, diagnostics });

  if (asJson) {
    process.stdout.write(JSON.stringify({
      schema: 'cascade:init-report:1',
      project: projectId,
      root,
      lanes,
      discovery: { ...discovery, diagnostics },
      manifest: p.manifest,
      profile: p.profile,
      written,
      kept,
      registry: regFile,
    }, null, 2) + '\n');
  }

  printSignpost(discovery, profile, { root, profilePath: path.relative(root, p.profile) || p.profile });
  process.exit(0);
}
