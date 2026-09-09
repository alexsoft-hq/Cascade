// state.mjs — the project's DURABLE state on disk, and the hashes that describe
// it: what a file's bytes are, where the calibration and golden state live, what
// this engine's own sources hash to, and what the working tree differs from.
//
// src/core/{calibration,trust,golden,receipt,invalidate,incremental}.mjs are
// pure and are handed these; this is the filesystem they are handed.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { enginePrint, isEngineSourcePath } from '../core/calibration.mjs';
import { parseCases } from '../core/golden.mjs';
import { buildReceipt, receiptTtlDaysOf } from '../core/receipt.mjs';
import { ownStateDirRel, withoutOwnState } from '../core/paths.mjs';
import { ENGINE_ROOT, realPath } from './env.mjs';

// ---- the filesystem/git edge the incremental core is injected with ---------
// src/core/{invalidate,incremental,facts_store}.mjs are pure; these small
// helpers are the only impure things they are handed.

/** sha256 of a file's BYTES (not its decoded text) — the shard keys' input. */
export function sha256File(absPath) {
  return createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
}

/** sha256 of a file that may have vanished between the diff and the hash. */
export function safeHash(abs) {
  try { return sha256File(abs); } catch { return null; }
}

/** sha256 of a file's bytes, or null when the file is absent. */
export function hashOrNull(file) {
  try { return sha256File(file); } catch { return null; }
}


/** Read + parse a JSON file, or null when it is not there. Throws on bad JSON. */
export function readJsonOrNull(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}


/** The durable state directory of a resolved project (`.cascade/`, or the pack's parent). */
export function stateDirOf(resolved, outDir) {
  if (resolved && typeof resolved.dotCascade === 'string' && resolved.dotCascade.length > 0) return resolved.dotCascade;
  return path.dirname(path.resolve(outDir));
}



/** A path inside the project's state directory, as the receipt spells it. */
export function relToState(stateDir, abs) {
  return path.relative(stateDir, abs).split(path.sep).join('/');
}


// src/core/{calibration,trust,golden,receipt}.mjs are pure; these helpers are
// the filesystem they are handed.

export const ENGINE_SKIP_DIRS = new Set(['node_modules', '.venv', '__pycache__', '.git', 'vendor']);

/** The engine's own sources, repository-relative and hashed, sorted by path. */
export function engineSourceList() {
  const out = [];
  const walk = (absDir, rel) => {
    let entries;
    try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.slice().sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (ENGINE_SKIP_DIRS.has(e.name)) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const childAbs = path.join(absDir, e.name);
      if (e.isDirectory()) walk(childAbs, childRel);
      else if (e.isFile() && isEngineSourcePath(childRel)) out.push({ path: childRel, sha256: sha256File(childAbs) });
    }
  };
  for (const top of ['src', 'bin', 'adapters']) walk(path.join(ENGINE_ROOT, top), top);
  return out;
}

let ENGINE_PRINT_CACHE = null;
/** sha256 of THIS engine's sources — the fingerprint the gate splits modes on. */
export function runningEnginePrint() {
  if (ENGINE_PRINT_CACHE === null) ENGINE_PRINT_CACHE = enginePrint({ files: engineSourceList() });
  return ENGINE_PRINT_CACHE;
}

/**
 * The calibration state a SERVER answers with: the last gate verdict and the
 * approved golden corpus. Both are read through the resolver's `.cascade/`;
 * a bare `--pack` has none, and the trust level then computes from no state
 * (UNCERTIFIED, `no-calibration-state`) rather than assuming the best.
 */
export function calibrationStateOf(dotCascade) {
  if (!dotCascade) return { gateState: null, golden: null };
  let gateState = null;
  try { gateState = readJsonOrNull(path.join(dotCascade, 'calibration', 'gate-state.json')); }
  catch (e) { process.stderr.write(`gate state ignored: ${e.message}\n`); }
  let golden = null;
  const casesFile = path.join(dotCascade, 'golden', 'cases.jsonl');
  if (fs.existsSync(casesFile)) {
    try {
      const cases = parseCases(fs.readFileSync(casesFile, 'utf8'));
      golden = { approvedCases: cases.filter((c) => !!c.approvedAt).length, summary: gateState?.goldenSummary ?? null };
    } catch (e) { process.stderr.write(`golden corpus ignored: ${e.message}\n`); }
  }
  return { gateState, golden };
}

// Working-tree files that differ from the pack's base commit: tracked
// modifications (diff vs base) plus untracked files. Repo-root-relative paths.
// Returns [] when there is no git base or git fails (the overlay then declines).
export function gitChangedFiles(base, ownDirRel = null) {
  if (!base || !base.repoPath || !base.commit) return [];
  const run = (args) => {
    try { return execFileSync('git', ['-C', base.repoPath, ...args], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 26 }).toString('utf8'); }
    catch { return ''; }
  };
  const tracked = run(['diff', '--name-only', base.commit, '--']);
  const untracked = run(['ls-files', '--others', '--exclude-standard']);
  const set = new Set();
  for (const line of (tracked + '\n' + untracked).split('\n')) { const f = line.trim(); if (f) set.add(f); }
  // The engine's own `.cascade/` is not source. The overlay has always excluded
  // it; this path (used by `--mode base-only` and by `ctx.changedFiles`) does the
  // same, through the SAME helper, so the two cannot describe different diffs.
  return withoutOwnState([...set].sort(), ownDirRel);
}

/** The `.cascade/` a served pack belongs to, as a path relative to its repo. */
export function ownStateOf(base, packDir) {
  if (!base || !base.repoPath) return null;
  return ownStateDirRel(realPath(base.repoPath), path.dirname(realPath(packDir)));
}

/**
 * THE RECEIPT (SPEC §14.4): what this certified run produced, hashed, so that a
 * later `cascade verify` can recompute every digest from the bytes on disk and
 * refuse the whole thing on any disagreement. `files` are absolute; the receipt
 * spells each one relative to the state directory, which is what makes it
 * readable after the project has been moved.
 *
 * @returns {Object} the receipt as it was written
 */
export function writeReceipt({ receiptFile, stateDir, builtAt, profile, print, pack, gateState, files }) {
  const receipt = buildReceipt({
    builtAt,
    ttlDays: receiptTtlDaysOf(profile),
    enginePrint: print,
    pack: { digest: pack.digest, project: pack.meta?.project ?? null },
    gate: { mode: gateState.mode, verdict: gateState.verdict, evaluatedAt: builtAt },
    files: files.map((abs) => ({ name: relToState(stateDir, abs), sha256: hashOrNull(abs) })),
  });
  fs.writeFileSync(receiptFile, JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}
