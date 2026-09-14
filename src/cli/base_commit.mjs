// base_commit.mjs — the pack of one project at another commit, for `cascade diff --base-commit`.
//
// A change is compared with the same project before it. Two ways to have that
// pack: the project's own history already holds a clean build at that commit
// (pack_history.mjs), or it is built now. Building it now means checking the
// commit out in a TEMPORARY git worktree, giving that worktree this project's
// CURRENT manifest and profile, and running `analyze` into a scratch directory.
// The profile is the current one on purpose: the two packs are then read the
// same way, and what differs is the code.
//
// THE TRAP THIS MODULE EXISTS TO AVOID. A profile names files by path. A path
// that points inside the repository must be read inside the WORKTREE, or the
// "base" pack is quietly built from today's DDL or today's frontend. A path that
// points outside the repository (a frontend checked out beside it, a DDL kept
// elsewhere) has no older version to read, so it stays where it is, and the
// comparison says so. Nothing is written to the project: the analysis goes to a
// scratch directory with `--out`, which registers nothing and seals nothing, and
// the worktree is removed afterwards, success or not.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CLI_PATH, gitText, realPath } from './env.mjs';
import { loadHistoryPack } from './pack_history.mjs';

/** Inside `root`, or `root` itself. */
const inside = (p, root) => p === root || p.startsWith(root + path.sep);

/**
 * Every path string in a profile or manifest, re-pointed for a copy of `.cascade`
 * placed in the worktree. Returns the rewritten value and the paths left outside.
 */
export function repointPaths(value, { fromDir, toDir, repoRoot, worktreeRoot }, outside = []) {
  if (Array.isArray(value)) return value.map((v) => repointPaths(v, { fromDir, toDir, repoRoot, worktreeRoot }, outside));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, repointPaths(v, { fromDir, toDir, repoRoot, worktreeRoot }, outside)]));
  }
  if (typeof value !== 'string') return value;
  const relative = value.startsWith('./') || value.startsWith('../') || value === '..' || value === '.';
  if (!relative && !path.isAbsolute(value)) return value;
  const abs = path.resolve(fromDir, value);
  if (inside(abs, repoRoot)) {
    const moved = path.join(worktreeRoot, path.relative(repoRoot, abs));
    return relative ? path.relative(toDir, moved).split(path.sep).join('/') || '.' : moved;
  }
  outside.push(abs);
  return abs;
}

/** A base that could not be built. Thrown, never exited on, so the worktree is always removed first. */
export class BaseCommitError extends Error {
  constructor(message) { super(message); this.name = 'BaseCommitError'; }
}

/** The last lines of a child's output, for a refusal that has to say why. */
const tail = (s, n = 8) => String(s ?? '').trim().split('\n').slice(-n).join('\n');

/**
 * The pack of this project at `rev`.
 *
 * @param {{rev:string, dotCascade:string, packDir:string, die:(msg:string)=>never, env?:object}} input
 * @returns {{pack:object, from:string, commit:string, outside:string[], entry?:object}}
 */
export function basePackAt({ rev, dotCascade: given, packDir, die, env = process.env }) {
  // REAL paths on every side: macOS's temp directory is `/var/...` spelled one way
  // and `/private/var/...` the other, and a DDL path compared across the two
  // spellings reads as outside the repository and would be read from today's tree.
  const dotCascade = realPath(given);
  const projectRoot = realPath(path.dirname(dotCascade));
  const repoTop = (gitText(projectRoot, ['rev-parse', '--show-toplevel']) ?? '').trim();
  if (!repoTop) die(`${projectRoot} is not in a git repository, so there is no other commit to compare with`);
  const repoRoot = realPath(repoTop);
  const commit = (gitText(repoRoot, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]) ?? '').trim();
  if (!commit) {
    const shallow = (gitText(repoRoot, ['rev-parse', '--is-shallow-repository']) ?? '').trim() === 'true';
    die(`no commit ${JSON.stringify(rev)} in ${repoRoot}${shallow ? '. This clone is shallow and may not hold it: fetch it first (git fetch origin <rev>, or git fetch --unshallow)' : ''}`);
  }
  const kept = loadHistoryPack(packDir, { commit });
  if (kept && !kept.entry.dirty) return { pack: kept.pack, from: 'history', commit, outside: [], entry: kept.entry };
  try {
    return buildInWorktree({ commit, dotCascade, repoRoot, projectRoot, env });
  } catch (e) {
    if (e instanceof BaseCommitError) die(e.message);
    throw e;
  }
}

/** Check the commit out beside the repository, analyze it into scratch, and clean up. */
function buildInWorktree({ commit, dotCascade, repoRoot, projectRoot, env }) {
  const scratch = realPath(fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-base-')));
  const worktreeRoot = path.join(scratch, 'worktree');
  const add = spawnSync('git', ['-C', repoRoot, 'worktree', 'add', '--detach', worktreeRoot, commit], { encoding: 'utf8' });
  try {
    if (add.status !== 0) throw new BaseCommitError(`could not check out ${commit.slice(0, 12)} in a worktree: ${tail(add.stderr)}`);
    const worktreeProject = path.join(worktreeRoot, path.relative(repoRoot, projectRoot));
    const target = path.join(worktreeProject, '.cascade');
    fs.mkdirSync(target, { recursive: true });
    const outside = [];
    const opts = { fromDir: dotCascade, toDir: target, repoRoot, worktreeRoot };
    for (const name of ['manifest.json', 'profile.json']) {
      const src = path.join(dotCascade, name);
      if (!fs.existsSync(src)) continue;
      const doc = JSON.parse(fs.readFileSync(src, 'utf8'));
      if (name === 'manifest.json' && Array.isArray(doc.repositories)) doc.repositories = doc.repositories.map((r) => (r.path === '..' ? { ...r, commit } : r));
      fs.writeFileSync(path.join(target, name), `${JSON.stringify(repointPaths(doc, opts, outside), null, 2)}\n`);
    }
    // A catalog snapshot lives in `.cascade/catalog/` and is not versioned with the
    // code: it is the database as it was fetched, so it is carried over as it is.
    const catalogDir = path.join(dotCascade, 'catalog');
    if (fs.existsSync(catalogDir) && fs.readdirSync(catalogDir).length > 0) {
      fs.cpSync(catalogDir, path.join(target, 'catalog'), { recursive: true });
      outside.push(catalogDir);
    }
    const out = path.join(scratch, 'pack');
    const run = spawnSync(process.execPath, [CLI_PATH, 'analyze', '--root', worktreeProject, '--out', out], { encoding: 'utf8', env, maxBuffer: 1 << 26 });
    if (run.status !== 0 || !fs.existsSync(path.join(out, 'pack.json'))) throw new BaseCommitError(`analyzing ${commit.slice(0, 12)} failed:\n${tail(run.stderr)}`);
    const pack = JSON.parse(fs.readFileSync(path.join(out, 'pack.json'), 'utf8'));
    return { pack, from: 'worktree', commit, outside: [...new Set(outside)].sort() };
  } finally {
    spawnSync('git', ['-C', repoRoot, 'worktree', 'remove', '--force', worktreeRoot], { encoding: 'utf8' });
    spawnSync('git', ['-C', repoRoot, 'worktree', 'prune'], { encoding: 'utf8' });
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
