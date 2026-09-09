// golden.mjs — `cascade golden`: the PROJECT golden corpus.
//
// The tool proposes; a human approves. This command never crosses that line:
// `propose` writes candidates and nothing else, and only `approve` (with --ids,
// or an explicit --all) stamps approval. A corpus a tool scored itself against
// measures nothing, which is why the refusal is worded the way it is.

import fs from 'node:fs';
import path from 'node:path';
import {
  proposeCases, approveCases, sealCases, checkCases, parseCases, serializeCases,
  inventoryOf, RELATIONS, MIN_CASES,
} from '../../core/golden.mjs';
import { loadPack } from '../../core/pack.mjs';
import { goldenAsk, servedProfile } from '../serve.mjs';
import { stateDirOf } from '../state.mjs';

/** Read one corpus file, or an empty corpus when it is not there yet. */
const readCases = (file) => (fs.existsSync(file) ? parseCases(fs.readFileSync(file, 'utf8')) : []);

/** The pack this corpus is about, and the bound `callTool` its cases go through. */
function askOf({ die }, resolved) {
  const packFile = path.join(resolved.packDir, 'pack.json');
  if (!fs.existsSync(packFile)) die(`no pack at ${packFile}. Run \`cascade analyze\` first`);
  const pack = JSON.parse(fs.readFileSync(packFile, 'utf8'));
  const graph = loadPack(pack, { verifyDigest: true });
  return { pack, graph, ask: goldenAsk(graph, pack, servedProfile(resolved.packDir, pack)) };
}

/** `propose`: sample candidates from the CURRENT pack. Nothing here is evidence. */
function runPropose({ opt, die }, { goldenDir, proposedFile, pack, graph, ask }) {
  const perRelation = Number(opt('per-relation', String(MIN_CASES)));
  if (!Number.isInteger(perRelation) || perRelation < 1) die('--per-relation must be a positive whole number');
  const { cases, perRelation: stats, notes } = proposeCases({ inventory: inventoryOf(graph), ask, packDigest: pack.digest, perRelation });
  fs.mkdirSync(goldenDir, { recursive: true });
  fs.writeFileSync(proposedFile, serializeCases(cases));
  for (const rel of RELATIONS) {
    const st = stats[rel];
    process.stdout.write(`${rel.padEnd(20)} proposed ${String(st.proposed).padStart(4)} of ${perRelation} `
      + `(${st.candidates} candidate(s) in the pack, ${st.skippedEmpty} answered nothing, ${st.skippedTruncated} truncated)\n`);
  }
  for (const n of notes) process.stdout.write(`note: ${n}\n`);
  process.stdout.write(`wrote ${cases.length} PROPOSAL(s) to ${proposedFile}\n`);
  process.stdout.write('these are candidates, not evidence: they were built from this engine\'s own answers, so they pass by construction.\n'
    + `read them, then approve the ones you agree with: \`cascade golden approve --ids <id> ...\` (or --all, explicitly).\n`);
  process.exit(0);
}

/** The per-relation scoreboard `check` prints when it is not asked for JSON. */
function printCheck(results, summary) {
  for (const rel of RELATIONS) {
    const r = summary.relations[rel];
    const fmt = (b) => (b.target == null
      ? 'no target is declared for this relation'
      : `${b.lowerBound == null ? 'n/a' : b.lowerBound.toFixed(4)} vs ${b.target}`
        + (b.meets ? '' : ` (a flawless corpus needs n>=${b.nForTarget} to reach it)`));
    process.stdout.write(`${rel.padEnd(20)} ${String(r.status).padEnd(20)} n=${String(r.n).padStart(4)}\n`
      + `  recall    ${r.recallHits}/${r.n} wilson ${fmt(r.recall)}\n`
      + `  precision ${r.precisionHits}/${r.n} wilson ${fmt(r.precision)}\n`);
  }
  const failed = results.filter((r) => r.status === 'FAIL');
  for (const f of failed.slice(0, 10)) process.stdout.write(`  FAIL ${f.id} ${f.relation}: ${f.reason}\n`);
  if (failed.length > 10) process.stdout.write(`  … ${failed.length - 10} more failing case(s)\n`);
  process.stdout.write(`golden ${summary.status}: ${summary.scored} scored, ${summary.unscorable} unscorable, `
    + `${MIN_CASES} cases per relation are the minimum before a relation can PASS\n`);
}

/** `check`: score the approved cases through the shipped MCP tools. */
function runCheck({ flag, die }, { casesFile, ask }) {
  const cases = readCases(casesFile);
  if (cases.length === 0) die(`no approved cases at ${casesFile}. Run \`cascade golden propose\` and then \`cascade golden approve\``);
  const { results, summary } = checkCases(cases, { ask });
  if (flag('json')) {
    process.stdout.write(JSON.stringify({ schema: 'cascade:golden-check:1', summary, results }, null, 2) + '\n');
  } else {
    printCheck(results, summary);
  }
  process.exit(summary.status === 'FAIL' ? 5 : 0);
}

/** `approve`: a HUMAN moves proposals into the corpus. Never the tool itself. */
function runApprove({ optAll, flag, die }, { goldenDir, proposedFile, casesFile }) {
  const proposed = readCases(proposedFile);
  if (proposed.length === 0) die(`nothing to approve: ${proposedFile} is empty or absent. Run \`cascade golden propose\` first`);
  const ids = optAll('ids').flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
  const all = flag('all');
  if (!all && ids.length === 0) die('cascade golden approve needs --ids <id>[,<id>…] or an explicit --all. This tool never approves its own proposals, because a corpus a tool scored itself against measures nothing');
  let moved;
  try { moved = approveCases(proposed, { ids, all, approvedAt: new Date().toISOString() }); }
  catch (e) { die(e.message); }
  if (moved.unknownIds.length > 0) die(`these ids are not in ${proposedFile}: ${moved.unknownIds.join(', ')}`);
  const existing = readCases(casesFile);
  const byId = new Map(existing.map((c) => [c.id, c]));
  for (const c of moved.approved) byId.set(c.id, c);
  fs.mkdirSync(goldenDir, { recursive: true });
  fs.writeFileSync(casesFile, serializeCases([...byId.values()]));
  fs.writeFileSync(proposedFile, serializeCases(moved.remaining));
  process.stdout.write(`approved ${moved.approved.length} case(s) into ${casesFile} (${byId.size} total), `
    + `${moved.remaining.length} proposal(s) left in ${proposedFile}\n`);
  process.exit(0);
}

/** `seal`: hide the labels of the held-out share, chosen by hash and not by you. */
function runSeal({ die }, { casesFile }) {
  const cases = readCases(casesFile);
  if (cases.length === 0) die(`no approved cases at ${casesFile}`);
  const { cases: sealed, sealed: count } = sealCases(cases);
  fs.writeFileSync(casesFile, serializeCases(sealed));
  process.stdout.write(`sealed ${count} of ${cases.length} case(s) in ${casesFile}. The held-out share is decided by sha256(id), never by hand. `
    + 'Their labels are now a hash, so the checker classifies the probe ids without seeing which side they are on\n');
  process.exit(0);
}

export function run(ctx) {
  const { argv, die, resolveOrDie } = ctx;
  const sub = argv[1];
  const SUBS = ['propose', 'approve', 'seal', 'check'];
  if (!SUBS.includes(sub)) {
    die(`usage: cascade golden <${SUBS.join('|')}> [--pack <dir> | --project <id> | --root <dir>]\n`
      + '  propose [--per-relation N]   sample candidates from the CURRENT pack into golden/proposed.jsonl.\n'
      + '                               They are PROPOSALS: built from the engine\'s own answers, so they are\n'
      + '                               right by construction and prove nothing until a human has read them.\n'
      + '                               This tool never approves its own proposals.\n'
      + '  approve --ids <id>... | --all   move proposals into golden/cases.jsonl with approvedAt.\n'
      + '  seal                         hide the labels of the held-out share (~20%, chosen by id hash, not by you).\n'
      + '  check [--json]               score the approved cases through the shipped MCP tools.');
  }
  const resolved = resolveOrDie();
  const stateDir = stateDirOf(resolved, resolved.packDir);
  const goldenDir = path.join(stateDir, 'golden');
  const proposedFile = path.join(goldenDir, 'proposed.jsonl');
  const casesFile = path.join(goldenDir, 'cases.jsonl');

  if (sub === 'propose' || sub === 'check') {
    const { pack, graph, ask } = askOf(ctx, resolved);
    if (sub === 'propose') runPropose(ctx, { goldenDir, proposedFile, pack, graph, ask });
    runCheck(ctx, { casesFile, ask });
  }
  if (sub === 'approve') runApprove(ctx, { goldenDir, proposedFile, casesFile });
  runSeal(ctx, { casesFile });
}
