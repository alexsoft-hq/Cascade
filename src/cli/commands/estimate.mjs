// estimate.mjs — `cascade estimate`: what this tree WILL support, and — when a
// pack already exists — what it measurably does. Both halves, always.
//
// WHICH TREE. The same rule `analyze` uses, and for the same reason. This used
// to be `--root` or cwd, so `cascade estimate --project mall` read the
// registered project's PACK for the measured half and the directory the shell
// happened to be in for the "before analysis" half: one report about two
// different projects, with nothing on it saying so.

import fs from 'node:fs';
import path from 'node:path';
import { discover } from '../../core/discover.mjs';
import { buildEstimate } from '../../core/estimate.mjs';
import { loadPack } from '../../core/pack.mjs';
import { DISCOVER_IO } from '../env.mjs';
import { analyzeRoot } from '../lanes_run.mjs';

/**
 * The pack that already exists, or nothing. A pack that cannot be read leaves
 * the MEASURED half out and says so, rather than being guessed at.
 */
function packForEstimate(packFile) {
  if (!fs.existsSync(packFile)) return { graph: null, meta: null };
  try {
    const p = JSON.parse(fs.readFileSync(packFile, 'utf8'));
    return {
      graph: loadPack(p, { verifyDigest: true }),
      meta: { digest: p.digest, builtAt: p.meta?.builtAt ?? null, lanes: p.meta?.lanes ?? null, axes: p.meta?.axes ?? null, laneStats: p.meta?.laneStats ?? null },
    };
  } catch (e) {
    process.stderr.write(`pack at ${packFile} could not be read (${e.message}), so the measured half is left out rather than guessed\n`);
    return { graph: null, meta: null };
  }
}

/** BEFORE ANALYSIS: what a run over this tree would ship, axis by axis. */
function printBefore(est, root, rootChoice) {
  // The banner names the tree AND why it is that tree, so a reader can tell a
  // report about the registered project from a report about the shell's cwd.
  process.stdout.write(`estimate for ${root} (${rootChoice.from})${est.project ? `, project ${est.project}` : ''}\n\nBEFORE ANALYSIS. What a run over this tree would ship:\n`);
  for (const a of est.before.axes) {
    process.stdout.write(`  ${a.axis.padEnd(11)} ${a.status.padEnd(12)} ${a.reason}\n`);
  }
  // The web axis's numbers, spelled out rather than left inside its sentence:
  // "how much frontend is there" is the first thing anyone asks of a lane that
  // reads one, and it is the same number the lane line will print.
  const webAxis = est.before.axes.find((a) => a.axis === 'web');
  if (webAxis && (webAxis.counts.webFiles > 0 || webAxis.counts.frontendPackages > 0)) {
    process.stdout.write(`  web files: ${webAxis.counts.webFiles} frontend source file(s) (${webAxis.counts.vueFiles} .vue) `
      + `in ${webAxis.counts.webSourceRoots} source root(s), from ${webAxis.counts.frontendPackages} frontend package(s)\n`);
  }
  // The service name and the gateway routes: not an axis, but the two things
  // that decide whether an answer can cross into another project.
  const id = est.before.identity ?? { serviceNames: [], gatewayRoutes: 0, gatewayRouteFiles: [], declaredServiceNames: [], declaredGatewayRoutes: 0 };
  for (const s of id.serviceNames) {
    process.stdout.write(`  service name: ${s.name} (from ${s.file})`
      + `${id.declaredServiceNames.includes(s.name)
        ? ', declared in the profile'
        : ', and not in the profile yet: cascade init --force writes it'}\n`);
  }
  if (id.gatewayRoutes > 0) {
    process.stdout.write(`  gateway routes: ${id.gatewayRoutes} read from ${id.gatewayRouteFiles.join(', ')}`
      + `; the profile declares ${id.declaredGatewayRoutes}\n`);
  }
  if (est.before.notCovered.length === 0) process.stdout.write('  not covered: nothing found that this engine has no lane for\n');
  for (const n of est.before.notCovered) process.stdout.write(`  not covered: ${n.technology} (${n.files} file(s)): ${n.reason}\n`);
}

/** MEASURED: what the pack that exists actually answers. */
function printMeasured(est) {
  process.stdout.write('\nMEASURED. What the pack that exists actually answers:\n');
  if (!est.measured) {
    process.stdout.write(`  ${est.measuredNote}\n`);
  } else {
    process.stdout.write(`  pack ${est.measured.pack.digest} built ${est.measured.pack.builtAt} lanes [${(est.measured.pack.lanes ?? []).join(',')}]\n`);
    const j = est.measured.jpa;
    if (j && (j.entities > 0 || j.repositories > 0)) {
      process.stdout.write(`  jpa: ${j.entities} entity table(s), ${j.repositories} repository(ies), ${j.statements} statement(s), `
        + `${j.unresolvedStatements} with an unresolved derived/JPQL part\n`);
    }
    for (const [name, r] of Object.entries(est.measured.ratios)) {
      const pct = r.pct == null ? 'n/a (nothing to measure)' : `${r.pct.toFixed(1)}%`;
      process.stdout.write(`  ${name.padEnd(28)} ${String(r.num).padStart(6)} / ${String(r.den).padEnd(6)} ${pct}${r.note ? `  (${r.note})` : ''}\n`);
    }
  }
}

export function run(ctx) {
  const { opt, flag, die, resolveOrDie, readProfile } = ctx;
  const resolved = resolveOrDie({ strictProject: false });
  const rootChoice = analyzeRoot(resolved, opt('root'), process.cwd());
  const root = rootChoice.root;
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    die(`the tree to estimate, ${root} (${rootChoice.from}), is not a directory`);
  }
  // The profile describes the TREE, the resolver locates the PACK: an explicit
  // --pack must not cost the estimate its reading convention.
  const { profile, profileNote } = readProfile(resolved.dotCascade ?? path.join(root, '.cascade'));
  const asJson = flag('json');
  if (!asJson) process.stderr.write(profileNote + '\n');

  const discovery = discover(root, DISCOVER_IO);
  const { graph, meta } = packForEstimate(path.join(resolved.packDir, 'pack.json'));

  const est = buildEstimate({
    discovery, profile, graph, pack: meta,
    root, project: resolved.projectId ?? null,
  });
  if (asJson) {
    process.stdout.write(JSON.stringify(est, null, 2) + '\n');
    process.exit(0);
  }
  printBefore(est, root, rootChoice);
  printMeasured(est);
  process.exit(0);
}
