// impact.mjs — `cascade impact`: the working-tree overlay from the shell.
//
// By default the dirty files are RE-PARSED (SPEC §10.2) so the answer describes
// the bytes on disk; `--mode base-only` asks the old question — what those files
// touched as the pack last saw them — and is labelled as such in the output.

import fs from 'node:fs';
import path from 'node:path';
import { loadPack } from '../../core/pack.mjs';
import { OverlayStaleError } from '../../core/overlay_lanes.mjs';
import { shortSessionId } from '../../core/overlay_session.mjs';
import { trustGapsFor } from '../../core/profile.mjs';
import { computeTrust } from '../../core/trust.mjs';
import { callTool } from '../../mcp/catalog.mjs';
import { makeOverlayProvider } from '../overlay_provider.mjs';
import { packMeta, runtimeEvidenceBasis, servedProfile } from '../serve.mjs';
import { calibrationStateOf, gitChangedFiles, ownStateOf } from '../state.mjs';

/**
 * WHICH OVERLAY, IF ANY. `--mode base-only` asks the old question — what these
 * files touched as the pack last saw them — and so builds no overlay at all. A
 * stale fact cache is a refusal with the base-only escape hatch in the sentence,
 * never a stack trace.
 */
function overlayFor({ die }, { baseOnly, dir, pack, graph, profile }) {
  if (baseOnly) return { overlayProvider: null, ov: null };
  const overlayProvider = makeOverlayProvider({ packDir: dir, pack, baseGraph: graph, profile });
  try {
    return { overlayProvider, ov: overlayProvider() };
  } catch (e) {
    if (e instanceof OverlayStaleError) {
      die(`overlay unavailable [${e.code}]: ${e.message}\n`
        + '  (`cascade impact --mode base-only` still answers from the pack: the PRE-EDIT structure, clearly labelled)');
    }
    throw e;
  }
}

/** The overlay's own line: which question the answer below is answering. */
function printOverlayLine({ baseOnly, o, ov, verbose }) {
  if (baseOnly) {
    process.stdout.write('mode base-only: this is the BASE pack\'s answer: what these files touched as they were LAST ANALYZED, not as they are on disk\n');
    return;
  }
  if (!o) return;
  if (!o.applied) {
    process.stdout.write(`overlay NOT applied (${o.state}): ${o.reason}\n`);
    return;
  }
  const t = o.timingsMs ?? {};
  process.stdout.write(`overlay ${shortSessionId(o.overlaySessionId)} (fresh): re-parsed ${o.parsedFiles.length} java + ${(o.parsedWebFiles ?? []).length} frontend file(s), `
    + `dropped ${o.droppedFiles.length + (o.droppedWebFiles ?? []).length}, `
    + `provisional ${o.provisionalIds.symbols.length + o.provisionalIds.endpoints.length + o.provisionalIds.statements.length} node(s) / ${o.provisionalEdges} edge(s)\n`);
  process.stdout.write(`timings ms: load-base ${t.loadBase} + java ${t.java} + web ${t.web} + sql ${t.sql} + graph ${t.build} = ${t.total}\n`);
  if (!verbose) return;
  process.stdout.write(`  reused ${ov.reusedShards} cached java shard(s); dirty documents: ${Object.entries(o.docVersions).map(([f, h]) => `${f}@${h ? h.slice(0, 8) : 'absent'}`).join(', ')}\n`);
  process.stdout.write(`  parsed: ${o.parsedFiles.join(', ') || '(none)'}\n`);
  if (o.unmatchedLanes.length) process.stdout.write(`  no lane claims: ${o.unmatchedLanes.join(', ')}\n`);
}

/** The answer itself: what was touched, what it reaches, and what it could not place. */
function printAnswer(resp) {
  const a = resp.answer;
  process.stdout.write(`changed files: ${a.changedFiles}  (matched ${a.files.matched.length}, unmatched ${a.files.unmatched.length})\n`);
  process.stdout.write(`touched: ${a.touched.symbols.length} symbols, ${a.touched.statements.length} statements, ${a.touched.endpoints.length} endpoints\n`);
  process.stdout.write(`\nupstream endpoints affected (${resp.truncated.fields[0].total}):\n`);
  for (const e of a.upstreamEndpoints) process.stdout.write(`  ${e.id}  [${e.grade}]${e.provisional ? '  PROVISIONAL (only in the overlay)' : ''}\n`);
  process.stdout.write(`\ndownstream columns affected (${resp.truncated.fields[1].total}):\n`);
  for (const c of a.downstreamColumns) process.stdout.write(`  ${c.id}  [${c.grade}]${c.provisional ? '  PROVISIONAL (only in the overlay)' : ''}\n`);
  if (a.files.unmatched.length) process.stdout.write(`\nchanged but not in graph (impact unknown, not zero):\n${a.files.unmatched.map((f) => '  ' + f).join('\n')}\n`);
  for (const l of resp.limits) process.stdout.write(`\nlimit [${l.scope}]: ${l.reason}\n`);
  process.stdout.write(`\n(${resp.basis.freshness.verdict}) ${a.note}\n`);
}

// `cli` rather than `ctx`, because the tool context built below is called `ctx`
// and they are different things: this one is the command line, that one is a
// loaded project.
export function run(cli) {
  const { opt, optAll, flag, die, resolveOrDie } = cli;
  const resolvedFor = resolveOrDie();
  const dir = resolvedFor.packDir;
  const file = path.join(dir, 'pack.json');
  if (!fs.existsSync(file)) die(`no pack at ${file}. Run cascade analyze first`);
  const pack = JSON.parse(fs.readFileSync(file, 'utf8'));
  const graph = loadPack(pack, { verifyDigest: true });
  const filesArg = optAll('file');
  const impactProfile = servedProfile(dir, pack);
  const modeArg = opt('mode', 'conservative');
  const baseOnly = modeArg === 'base-only';
  const verbose = flag('verbose');

  const { overlayProvider, ov } = overlayFor(cli, { baseOnly, dir, pack, graph, profile: impactProfile });
  const files = filesArg.length ? filesArg : (ov ? ov.dirtyFiles : gitChangedFiles(pack.meta?.base, ownStateOf(pack.meta?.base, dir)));
  if (!files.length) die('no changed files. Pass --file <path> [--file …], or edit the repo the pack was built from');
  const ctx = {
    graph,
    basis: {
      project: pack.meta?.project ?? 'project', buildDigest: pack.digest,
      builtAt: pack.meta?.builtAt ?? null, freshness: { verdict: 'unknown' },
      ...(runtimeEvidenceBasis(pack) ?? {}),
    },
    trust: computeTrust({ ...calibrationStateOf(resolvedFor.dotCascade), knownGaps: trustGapsFor(impactProfile, pack.meta?.axes ?? null) }),
    limits: [], pack: packMeta(pack), profile: impactProfile,
    ...(overlayProvider ? { overlay: overlayProvider } : {}),
  };
  const resp = callTool('changed_impact', { files, mode: baseOnly ? 'conservative' : modeArg }, ctx);
  printOverlayLine({ baseOnly, o: resp.answer.overlay ?? null, ov, verbose });
  printAnswer(resp);
  process.exit(0);
}
