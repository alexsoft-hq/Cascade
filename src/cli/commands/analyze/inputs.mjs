// analyze/inputs.mjs — everything a run decides BEFORE a worker starts.
//
// Who this run is about, which tree it reads, by what reading convention, which
// lanes are on and over which files, and whether the shards from last time
// still apply. Three questions, three functions, in the order the run asks
// them — and none of them prints a lane census or writes a byte of a pack.
//
// Every decision inside is somebody else's: `src/core/lanes.mjs` chooses the
// lanes, `src/core/invalidate.mjs` chooses cold or incremental,
// `src/core/profile.mjs` reads the convention. What lives here is the
// filesystem and git edge those pure rules are handed.

import fs from 'node:fs';
import path from 'node:path';
import { buildChangeset } from '../../../core/changeset.mjs';
import { discover, isWebSourceFile } from '../../../core/discover.mjs';
import { createFactsStore, nodeFactsIo, validateIndex } from '../../../core/facts_store.mjs';
import { INCREMENTAL_ENGINE_VERSION } from '../../../core/incremental.mjs';
import { planIncremental, underAny, MODE_COLD } from '../../../core/invalidate.mjs';
import { selectLanes } from '../../../core/lanes.mjs';
import { loadManifest } from '../../../core/manifest.mjs';
import { profileDiagnostics, sqlDialectOf } from '../../../core/profile.mjs';
import { workerVersions } from '../../../core/worker_versions.mjs';
import { DISCOVER_IO, catalogPathsOf, gitText, projectIdFrom, realPath, splitZ } from '../../env.mjs';
import { analyzeRoot, expandDdlPatterns } from '../../lanes_run.mjs';
import { sha256File } from '../../state.mjs';

/**
 * WHO THIS RUN IS ABOUT, WHICH TREE IT READS, AND BY WHAT CONVENTION.
 *
 * `cascade analyze --project mall` run from anywhere else used to analyze the
 * directory the shell happened to be in and write the result into mall's pack:
 * a pack named after one project describing another. The resolver already knows
 * which project this is; `analyzeRoot` asks it where that project lives.
 */
export function analyzeTarget({ opt, die, resolveOrDie, readProfile }) {
    const resolved = resolveOrDie({ strictProject: false });
    const out = opt('out', resolved.packDir);
    // WHAT GETS ANALYZED. This used to be `--root` or cwd, full stop, so
    // `cascade analyze --project mall` run from anywhere else analyzed the
    // directory the shell happened to be in and wrote the result into mall's pack:
    // a pack named after one project describing another. The resolver already
    // knows which project this is; `analyzeRoot` asks it where that project lives.
    //
    // Symlinks are resolved here, at the filesystem edge: on macOS /var is a link
    // to /private/var, and git reports the physical path, so a root given through
    // the other spelling would make every "is this file under a source root?"
    // comparison fail silently, by returning "nothing changed". Every lane input
    // below is resolved the same way.
    const rootChoice = analyzeRoot(resolved, opt('root'), process.cwd());
    const root = realPath(rootChoice.root);
    process.stderr.write(`analyzing ${root} (${rootChoice.from})\n`);

    // ---- the reading convention (SPEC §6.2) --------------------------------
    const { profile, profileFile, profileNote } = readProfile(resolved.dotCascade);
    if (profileNote) process.stderr.write(profileNote + '\n');
    let diagnostics;
    try {
      diagnostics = profileDiagnostics(profile);
    } catch (e) { die(e.message); }
    // Fail closed on a dialect this engine cannot route: a wrong dialect
    // mis-parses every statement and the result would still look healthy.
    try { sqlDialectOf(profile); } catch (e) { die(e.message); }

    // ---- project identity (SPEC §6.1): is the pinned commit what we analyze? --
    const manifestFile = resolved.dotCascade ? path.join(resolved.dotCascade, 'manifest.json') : null;
    let manifest = null;
    if (manifestFile && fs.existsSync(manifestFile)) {
      try { manifest = loadManifest(manifestFile); }
      catch (e) { process.stderr.write(`manifest ignored: ${e.message}\n`); }
  }
    return { resolved, out, rootChoice, root, profile, profileFile, diagnostics, manifest };
}

/**
 * THE LANE FLAGS, and the one contradiction they can carry. `--no-<lane>` and
 * `--<lane>` on the same line is a run that cannot be honest about what it read,
 * so it is refused rather than resolved by precedence.
 */
export function laneFlags({ optAll, flag, die }) {
  const flags = {
    // Repeatable, and each value may be a glob: a schema split over three
    // services is `--ddl a.sql --ddl b.sql --ddl c.sql` or `--ddl 'db/*/schema.sql'`.
    ddl: expandDdlPatterns(optAll('ddl')), noDdl: flag('no-ddl'),
    mappers: optAll('mappers'), noMappers: flag('no-mappers'),
    javaSrc: optAll('java-src'), noJava: flag('no-java'),
    webSrc: optAll('web-src'), noWeb: flag('no-web'),
    // An OpenAPI / Swagger document the project publishes. Repeatable, because a
    // repository with several services publishes one document per service.
    openapi: optAll('openapi'), noOpenapi: flag('no-openapi'),
    // A browser recording, as runtime evidence on the screen axis (RM30). No
    // `--no-har` sibling and no discovery: nothing reads one unless a person
    // names it here or in the profile.
    har: optAll('har'),
    // An OpenTelemetry trace export, as runtime evidence on the DISPATCH axis:
    // which implementation really handled a request, and which statement really
    // ran. Same posture as --har, and for the same reason: no discovery, and
    // nothing it writes is ever walked.
    otel: optAll('otel'),
  };
  for (const [off, on, name] of [[flags.noDdl, flags.ddl.length, 'ddl'], [flags.noMappers, flags.mappers.length, 'mappers'], [flags.noJava, flags.javaSrc.length, 'java-src'], [flags.noWeb, flags.webSrc.length, 'web-src'], [flags.noOpenapi, flags.openapi.length, 'openapi']]) {
    if (off && on) die(`--no-${name === 'java-src' ? 'java' : name === 'web-src' ? 'web' : name} and --${name} contradict each other. Pass one or the other`);
  }
    return flags;
}

/**
 * EVERY LANE INPUT, RESOLVED THROUGH ITS SYMLINKS and checked for existence.
 *
 * On macOS /var is a link to /private/var and git reports the physical path, so
 * a root given through the other spelling would make every "is this file under
 * a source root?" comparison fail silently, by answering "nothing changed".
 */
export function laneInputs({ die }, { sel, resolved, diagnostics }) {
  const ddls = sel.ddls.map(realPath);
  const ddl = ddls[0] ?? null;
  const snapshot = sel.snapshot ? realPath(sel.snapshot) : null;
  const mappers = sel.mappers.map(realPath);
  const javaSrc = sel.javaSrc.map(realPath);
  const webSrc = sel.webSrc.map(realPath);
  for (const f of sel.openapi) if (!fs.existsSync(f)) die(`--openapi ${f} does not exist`);
  const openapiFiles = sel.openapi.map(realPath);
  for (const f of sel.har) if (!fs.existsSync(f)) die(`--har ${f} does not exist`);
  const harFiles = sel.har.map(realPath);
  for (const f of sel.otel) if (!fs.existsSync(f)) die(`--otel ${f} does not exist`);
  const otelFiles = sel.otel.map(realPath);
  for (const f of ddls) if (!fs.existsSync(f)) die(`--ddl ${f} does not exist`);
  for (const d of webSrc) if (!fs.existsSync(d)) die(`--web-src ${d} does not exist`);
  // §17.4: a structured, actionable error — not "0 tables" three screens later.
  if (snapshot && !fs.existsSync(snapshot)) {
    process.stderr.write(JSON.stringify({
      error: 'db-catalog-missing',
      catalogSource: 'jdbc',
      expected: snapshot,
      remedy: 'cascade catalog fetch --candidate <n> --password-env <VAR> --yes',
    }) + '\n');
    die(`profile catalog.source is "jdbc" but there is no pinned snapshot at ${snapshot}.\n`
      + '  Analysis never connects to a database. It reads a snapshot you fetched deliberately.\n'
      + '  Run `cascade catalog discover` to see the connection candidates, then\n'
      + '  `cascade catalog fetch --candidate <n> --password-env <VAR> --yes` to pin one.\n'
      + '  Or set catalog.source to "file"/"none" in the profile.');
  }
  let snapshotProvenance = null;
  let snapshotSha256 = null;
  if (snapshot) {
    snapshotSha256 = sha256File(snapshot);
    const provFile = catalogPathsOf(resolved.dotCascade).catalogSnapshot;
    try { snapshotProvenance = JSON.parse(fs.readFileSync(provFile, 'utf8')); }
    catch { snapshotProvenance = null; }
    if (snapshotProvenance && snapshotProvenance.sha256 && snapshotProvenance.sha256 !== snapshotSha256) {
      // The provenance describes a fetch; the file is what gets analyzed. When
      // they disagree the file wins and the disagreement is stated — a snapshot
      // edited by hand must not travel under a fetch's credentials (§17.2).
      diagnostics.push({
        kind: 'SNAPSHOT_PROVENANCE_STALE', severity: 'warn', key: 'catalog.source',
        reason: `${snapshot} no longer hashes to the sha256 recorded in ${provFile} `
          + `(${snapshotProvenance.sha256.slice(0, 12)}… vs ${snapshotSha256.slice(0, 12)}…). The file on disk is what was analyzed. `
          + 'Re-run `cascade catalog fetch` to make the provenance describe it again',
      });
    }
  }
    return { ddls, ddl, snapshot, snapshotProvenance, snapshotSha256, mappers, javaSrc, webSrc, openapiFiles, harFiles, otelFiles };
}

/**
 * WHAT RUNS, OVER WHAT (src/core/lanes.mjs decides).
 *
 * The flags are read first and discovery runs only for the lanes no flag named,
 * because walking a tree nobody asked about is the slowest thing this command
 * can do. A run that ends up with no lane at all does not produce an empty pack:
 * it says what it looked for and what it found, and stops.
 */
export function laneSelection(ctx, { root, profile, resolved, diagnostics }) {
    const { die } = ctx;
    const flags = laneFlags(ctx);
  const needDiscovery = (flags.ddl.length === 0 && !flags.noDdl)
    || (flags.mappers.length === 0 && !flags.noMappers)
    || (flags.javaSrc.length === 0 && !flags.noJava)
    || (flags.webSrc.length === 0 && !flags.noWeb)
    || (flags.openapi.length === 0 && !flags.noOpenapi);
  let discovery = null;
  if (needDiscovery) {
    process.stderr.write('discovering the tree (no lane flag given for every lane)…\n');
    discovery = discover(path.resolve(root), DISCOVER_IO);
  }
  // The catalog can come from a DDL file or from the PINNED SNAPSHOT that
  // `cascade catalog fetch` wrote (SPEC §12, §15 M5). This run never connects
  // to a database either way — §2.3 allows zero network calls in the extraction
  // path, and a snapshot is a file like any other.
  const snapshotFile = resolved.dotCascade ? catalogPathsOf(resolved.dotCascade).catalog : null;
  const sel = selectLanes({
    flags, profile, discovery, root: path.resolve(root),
    manifestDir: resolved.dotCascade, cwd: process.cwd(),
    catalogSnapshot: snapshotFile,
  });
    diagnostics = [...diagnostics, ...sel.diagnostics];
    const inputs = laneInputs(ctx, { sel, resolved, diagnostics });
  if (sel.lanes.length === 0) {
    const c = discovery ? discovery.counts : null;
    die('nothing to analyze: no DDL, no mapper XML and no Java source were given or found.\n'
      + (c
        ? `  discovery under ${path.resolve(root)} found: ${c.javaFiles} java file(s) (${c.springHandlerFiles} with a Spring mapping), `
          + `${c.mybatisMapperXml} mybatis mapper xml${(c.ibatisSqlMapXml ?? 0) > 0 ? ` and ${c.ibatisSqlMapXml} ibatis sqlMap xml` : ''}, `
          + `${c.ddlFiles} DDL file(s) with CREATE TABLE, ${c.kotlinFiles} kotlin, ${c.frontendPackageJson} frontend package.json, ${c.webFiles} frontend source file(s)\n`
          + `  mapper directories: ${discovery.mapperDirs.length ? discovery.mapperDirs.join(', ') : '(none)'}\n`
          + `  java source roots: ${discovery.javaSourceRoots.length ? discovery.javaSourceRoots.join(', ') : '(none)'}\n`
          + `  web source roots: ${(discovery.webSourceRoots ?? []).length ? discovery.webSourceRoots.join(', ') : '(none)'}\n`
          + `  profile frameworkPacks: [${(profile.frameworkPacks ?? []).join(', ')}], catalog.source: ${profile.catalog?.source}\n`
        : '')
      + '  pass --ddl / --mappers / --java-src / --web-src explicitly, or run `cascade init` so the profile declares the lanes.');
  }
    return { flags, discovery, sel, ...inputs, diagnostics };
}

/** The three path spellings the rest of a run works in, plus this tree's HEAD. */
export function pathSpellings(rootAbs) {
  // git prints repo-top-relative paths; the fact index speaks --root-relative,
  // so every path crosses over here, once, and anything outside --root is
  // dropped (it cannot be an input to this analysis).
  const gitTopRaw = ((gitText(rootAbs, ['rev-parse', '--show-toplevel']) ?? '').trim()) || null;
  const gitTop = gitTopRaw ? realPath(gitTopRaw) : null;
  const headCommit = ((gitText(rootAbs, ['rev-parse', 'HEAD']) ?? '').trim()) || null;
  const toRootRel = (repoRelPath) => {
    if (!gitTop) return null;
    const rel = path.relative(rootAbs, path.resolve(gitTop, repoRelPath));
    return rel.startsWith('..') || path.isAbsolute(rel) ? null : rel.split(path.sep).join('/');
  };
  const relOf = (absPath) => path.relative(rootAbs, realPath(path.resolve(absPath))).split(path.sep).join('/');
  const absOf = (relPath) => path.resolve(rootAbs, relPath);
    return { gitTop, headCommit, toRootRel, relOf, absOf };
}

/**
 * WHAT THIS RUN ANALYZES, as the fact index records it. A project that gains or
 * loses a lane analyzes a different set of inputs, and src/core/invalidate.mjs
 * turns that into one cold run with "the lane selection changed" as the reason.
 */
export function selectionRecord({ rootAbs, javaSrc, mappers, webSrc, sel, ddls, snapshot, sqlArgs, profile, relOf }) {
  const selectionRel = {
    root: rootAbs,
    javaRoots: javaSrc.map(relOf).sort(),
    mapperDirs: mappers.map(relOf).sort(),
    // The web lane's roots. Sharded per file since RM29, and part of the
    // SELECTION: a project that gains or loses the web lane analyzes a different
    // set of inputs, and src/core/invalidate.mjs turns that into one cold run
    // with "the lane selection changed" as the reason.
    webRoots: webSrc.map(relOf).sort(),
    // WHERE A VIEW NAME BECOMES A PAGE (RM48). Part of the SELECTION for the
    // same reason the web roots are: a project that gains or loses its template
    // roots analyzes a different set of inputs, and one cold run with "the lane
    // selection changed" is the correct price.
    templateRoots: sel.templateRoots
      .map((t) => ({ root: relOf(t.root), engine: t.engine, suffix: t.suffix }))
      .sort((a, b) => (a.root < b.root ? -1 : 1)),
    // Whichever file feeds the catalog axis. Recording it here is what makes a
    // switch between a DDL and a snapshot force a cold run instead of quietly
    // mixing two generations of catalog facts (src/core/invalidate.mjs).
    ddls: ddls.length > 0 ? ddls.map(relOf) : snapshot ? [relOf(snapshot)] : [],
    sqlArgs: [...sqlArgs.mybatisArgs, ...sqlArgs.lineageArgs],
    packagePrefixes: [...(profile.packagePrefixes ?? [])].sort(),
  };
    return selectionRel;
}

/**
 * THE CHANGESET: the previous pack's base commit against the WORKING TREE (this
 * engine analyzes the tree, not the blob). Untracked files under the analyzed
 * roots count as added.
 */
export function changesetOf({ rootAbs, out, gitTop, headCommit, toRootRel }) {
  const indexFile = path.join(out, 'facts-index.json');
  let prevIndex = null;
  if (fs.existsSync(indexFile)) {
    try { prevIndex = validateIndex(JSON.parse(fs.readFileSync(indexFile, 'utf8'))); }
    catch (e) { process.stderr.write(`facts index at ${indexFile} is unusable (${e.message}), so this run is cold\n`); }
  }

  // The changeset: the previous pack's base commit vs the WORKING TREE (this
  // engine analyzes the tree, not the blob — §2.1 item 2 is the overlay's job).
  // Untracked files under the analyzed roots count as added.
  const baseCommit = prevIndex?.base?.commit ?? null;
  let changeset = buildChangeset({ repo: rootAbs, fromCommit: null, toCommit: headCommit });
  if (baseCommit && gitTop) {
    const raw = gitText(rootAbs, ['diff', '--name-status', '-z', baseCommit, '--']);
    if (raw == null) {
      changeset = { ...changeset, reason: `git diff against ${baseCommit.slice(0, 12)} failed. The commit is not in this repository any more` };
    } else {
      try {
        const cs = buildChangeset({ repo: rootAbs, fromCommit: baseCommit, toCommit: headCommit ?? 'WORKING-TREE', rawNameStatusZ: raw });
        changeset = { ...cs, files: cs.files.map((f) => ({ ...f, repoPath: toRootRel(f.repoPath) })).filter((f) => f.repoPath !== null) };
      } catch (e) {
        changeset = { ...changeset, reason: `the git diff could not be parsed: ${e.message}` };
      }
    }
  }
  const untrackedRel = splitZ(gitText(rootAbs, ['ls-files', '--others', '--exclude-standard', '--full-name', '-z']))
    .map(toRootRel).filter((f) => f !== null);
    return { prevIndex, changeset, untrackedRel, baseCommit };
}

/**
 * WHICH FILES MAKE THIS PACK PROVISIONAL. "Dirty" here means an ANALYSIS INPUT
 * differs from HEAD — that is what makes the pack the working tree's state
 * rather than a commit's certified one. An unrelated edited file elsewhere in
 * the repository does not.
 */
export function dirtyInputsOf({ rootAbs, headCommit, toRootRel, untrackedRel, selectionRel }) {
  // "Dirty" for this pack means an ANALYSIS INPUT differs from HEAD — that is
  // what makes the pack provisional rather than a commit's certified state
  // (§2.1 item 2). An unrelated edited file elsewhere in the repo does not.
  const isAnalysisInput = (f) => (f.endsWith('.java') && underAny(f, selectionRel.javaRoots))
    || (f.endsWith('.xml') && underAny(f, selectionRel.mapperDirs))
    || (isWebSourceFile(f) && underAny(f, selectionRel.webRoots))
    // A template is an input of the web lane like any frontend source (RM48).
    || selectionRel.templateRoots.some((t) => f.endsWith(t.suffix) && underAny(f, [t.root]))
    || selectionRel.ddls.includes(f);
  const dirtyFiles = [...new Set([
    ...splitZ(gitText(rootAbs, ['diff', '--name-only', '-z', 'HEAD', '--'])).map(toRootRel),
    ...untrackedRel,
  ])].filter((f) => f !== null && isAnalysisInput(f)).sort();
  const base = headCommit
    ? { repoPath: rootAbs, commit: headCommit, dirty: dirtyFiles.length > 0, dirtyFiles }
    : null;
    return { dirtyFiles, base };
}

/**
 * COLD OR INCREMENTAL, and where the shards go.
 *
 * WHO THIS RUN IS ABOUT (SPEC §5.1) addresses the fact cache and becomes
 * `pack.meta.project`. Without a filesystem-safe id there is nowhere durable to
 * put shards, so the run is cold and nothing is kept — and it says so.
 */
export function planOf({ flag, opt }, { resolved, manifest, rootAbs, prevIndex, changeset, untrackedRel, selectionRel, absOf }) {
    const wantCold = flag('cold');
    const wantIncremental = flag('incremental');
  // WHO THIS RUN IS ABOUT (SPEC §5.1), computed once for the whole command.
  // It addresses the fact cache, and further down it is what the pack records
  // as `meta.project`. Without a filesystem-safe id there is nowhere durable to
  // put shards, so the run is cold and nothing is kept.
  const projectId = projectIdFrom(resolved.projectId, manifest?.project, opt('project'), path.basename(rootAbs));

  let plan;
  if (!projectId) {
    plan = {
      mode: MODE_COLD, notes: [], reparseJava: [], dropJava: [], sqlChanged: true, catalogChanged: true, reuse: { java: 0 },
      reason: `no filesystem-safe project id could be derived for the fact cache. Run \`cascade init --project <id>\` to make this project's runs incremental`,
    };
  } else {
    plan = planIncremental({
      requestedMode: wantCold ? 'cold' : 'auto',
      index: prevIndex,
      changeset,
      untracked: untrackedRel,
      selection: selectionRel,
      workers: workerVersions(),
      engineVersion: INCREMENTAL_ENGINE_VERSION,
      stillExists: (f) => fs.existsSync(absOf(f)),
    });
  }
  if (wantIncremental && plan.mode === MODE_COLD) {
    process.stderr.write(`--incremental was asked for, but this run must be cold: ${plan.reason}\n`);
  }
  // With no usable project id the shards go to a throwaway in-memory store: the
  // run still works, it just cannot be reused next time — and it says so above.
  const memFiles = new Map();
  const storeIo = projectId ? nodeFactsIo(fs) : {
    readFile: (p) => memFiles.get(p), writeFile: (p, s) => memFiles.set(p, s),
    exists: (p) => memFiles.has(p), mkdir: () => {},
  };
  const store = createFactsStore({ io: storeIo, projectId: projectId ?? 'nocache', env: process.env });
    return { projectId, plan, store };
}

/**
 * THE INCREMENTAL CORE'S IMPURE EDGE (SPEC §11, §15 M6).
 *
 * Everything that DECIDES is pure and lives in
 * src/core/{changeset,invalidate,facts_store,incremental}.mjs. This supplies
 * git and the filesystem those rules are handed.
 */
export function incrementalPlan(ctx, { root, out, profile, manifest, resolved, sel, ddls, snapshot, mappers, javaSrc, webSrc, sqlArgs }) {
  const { flag, die } = ctx;
  const rootAbs = root;
  if (flag('cold') && flag('incremental')) die('--cold and --incremental contradict each other. Pass one or the other');
  const { gitTop, headCommit, toRootRel, relOf, absOf } = pathSpellings(rootAbs);
  const selectionRel = selectionRecord({ rootAbs, javaSrc, mappers, webSrc, sel, ddls, snapshot, sqlArgs, profile, relOf });
  const { prevIndex, changeset, untrackedRel, baseCommit } = changesetOf({ rootAbs, out, gitTop, headCommit, toRootRel });
  const { base } = dirtyInputsOf({ rootAbs, headCommit, toRootRel, untrackedRel, selectionRel });
  const { projectId, plan, store } = planOf(ctx, {
    resolved, manifest, rootAbs, prevIndex, changeset, untrackedRel, selectionRel, absOf,
  });
  return { selectionRel, prevIndex, base, baseCommit, projectId, plan, store, relOf, absOf };
}
