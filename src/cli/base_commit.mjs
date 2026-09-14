// base_commit.mjs — the pack of one project at another commit, analyzed the way its current pack was, for `cascade diff --base-commit`.
//
// A change is compared with the same project before it, READ THE SAME WAY. Two
// ways to have that pack:
//
//   kept    the project's history holds a clean build at that commit
//           (pack_history.mjs) that was analyzed under the same conditions as
//           the current pack. A kept build analyzed differently (an older
//           engine, another profile) is not used: the base is built again.
//   built   the commit is checked out in a TEMPORARY git worktree, given this
//           project's manifest and the profile the current pack was analyzed
//           with, and `analyze` is run with the very lane flags the current pack
//           recorded (`meta.analysis.invocation`), into a scratch directory with
//           `--out`, which registers nothing and seals nothing. A current pack
//           that records no invocation cannot be reproduced, and is refused.
//
// THE TRAP THIS MODULE EXISTS TO AVOID. A profile and the lane flags name files
// by path. A path that points inside the repository must be read inside the
// WORKTREE, or the "base" pack is quietly built from today's DDL or today's
// frontend; the decision is made on REAL paths, because macOS spells its temp
// directory `/var` and `/private/var` at once. A path outside the repository (a
// frontend checked out beside it) has no older version to read, so it stays
// where it is, and the comparison lists it. The worktree is removed afterwards,
// and a removal that did not happen is an error, never a silence.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { compareConditions } from '../core/pack_diff.mjs';
import { CLI_PATH, gitText, realPath } from './env.mjs';
import { changedSince } from './external_sources.mjs';
import { repositoryIdentity } from './commands/analyze/inputs.mjs';
import { loadHistoryPack } from './pack_history.mjs';

/** Inside `root`, or `root` itself. */
const inside = (p, root) => p === root || p.startsWith(root + path.sep);

/**
 * Every path string in a profile or manifest, re-pointed for a copy of `.cascade`
 * placed in the worktree. The paths left outside the repository are pushed onto `outside`.
 */
export function repointPaths(value, opts, outside = []) {
  if (Array.isArray(value)) return value.map((v) => repointPaths(v, opts, outside));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, repointPaths(v, opts, outside)]));
  if (typeof value !== 'string') return value;
  // `..\\front\\src` is as relative on Windows as `../front/src` is everywhere.
  const relative = /^\.\.?(?:[\\/]|$)/.test(value);
  if (!relative && !path.isAbsolute(value)) return value;
  const moved = moveIntoWorktree(path.resolve(opts.fromDir, value), opts, outside);
  return relative && inside(moved, opts.worktreeRoot) ? (path.relative(opts.toDir, moved).split(path.sep).join('/') || '.') : moved;
}

/** One absolute path, as the worktree reads it: moved in when it is in the repository, kept (and listed) when it is not. */
function moveIntoWorktree(abs, { repoRoot, worktreeRoot }, outside) {
  const real = realPath(abs);
  if (inside(real, repoRoot)) return path.join(worktreeRoot, path.relative(repoRoot, real));
  outside.push(real);
  return real;
}

/** A base that could not be built. Thrown, never exited on, so the worktree is always removed first. */
export class BaseCommitError extends Error {
  constructor(message) { super(message); this.name = 'BaseCommitError'; }
}

/** The last lines of a child's output, for a refusal that has to say why. */
const tail = (s, n = 8) => String(s ?? '').trim().split('\n').slice(-n).join('\n');

/**
 * The pack of this project at `rev`, read the way `headPack` was.
 *
 * @param {{rev:string, dotCascade:string, packDir:string, headPack:object, die:(msg:string)=>never, env?:object}} input
 * @returns {{pack:object, from:string, commit:string, outside:string[], entry?:object, note?:string}}
 */
export function basePackAt({ rev, dotCascade: given, packDir, headPack, die, env = process.env }) {
  const dotCascade = realPath(given);
  const projectRoot = analyzedTreeOf(dotCascade, headPack);
  const { repoRoot, commit } = commitOf(projectRoot, rev, die);
  refuseUnreproducible(headPack, die);
  const invocation = headPack.meta.analysis.invocation;
  const kept = loadHistoryPack(packDir, { commit });
  let note = null;
  if (kept) {
    const c = compareConditions(kept.pack, headPack);
    if (c.verdict === 'same') return { pack: kept.pack, from: 'history', commit, outside: [], entry: kept.entry };
    note = `the kept build at this commit was analyzed differently (${[...c.differences.map((d) => d.what), ...c.unknown].join(', ')}), so it was built again`;
  }
  try {
    return { ...buildInWorktree({ commit, dotCascade, repoRoot, projectRoot, invocation, env }), note };
  } catch (e) {
    if (e instanceof BaseCommitError) die(e.message);
    throw e;
  }
}

/**
 * THE TREE THE CURRENT PACK READ, where the commit is looked up. Normally the one
 * its `.cascade` sits in, and that stays the answer for a project copied or moved
 * elsewhere, whose pack still records the old path. The recorded path is taken
 * instead only when the configuration's own tree is NOT the repository and folder
 * the pack recorded and the recorded tree IS (`analyze --project mine --root other`).
 */
export function analyzedTreeOf(dotCascade, headPack) {
  const own = realPath(path.dirname(dotCascade));
  const recorded = headPack.meta?.base?.repoPath;
  if (!recorded || !fs.existsSync(recorded) || realPath(recorded) === own) return own;
  return !sameCheckout(own, headPack.meta.base) && sameCheckout(realPath(recorded), headPack.meta.base) ? realPath(recorded) : own;
}

/** Whether a directory is the repository (by root commit, else remote) and the folder in it that a pack recorded. */
function sameCheckout(dir, base) {
  const top = (gitText(dir, ['rev-parse', '--show-toplevel']) ?? '').trim();
  if (!top) return false;
  const id = repositoryIdentity(dir, realPath(top));
  const field = ['rootCommit', 'remote'].find((f) => id[f] && base[f]);
  return !!field && id[field] === base[field] && (typeof base.projectPath !== 'string' || id.projectPath === base.projectPath);
}

/**
 * A current pack whose analysis cannot be reproduced is refused, before the
 * history is looked at, so a kept build is never chosen for a head that could not
 * have been rebuilt: one that records no invocation (a kept build recording none
 * either would compare as "the same"), and one whose inputs outside the
 * repository have changed on disk since it was analyzed (the history would give
 * the base the old content and a rebuild the new, and the answer would depend on
 * which one happened to exist).
 */
function refuseUnreproducible(headPack, die) {
  if (!headPack.meta?.analysis?.invocation) {
    die('the current pack does not record how it was analyzed, so its base cannot be analyzed the same way. Run `cascade analyze` once, then compare');
  }
  const changed = headPack.meta.analysis.external?.sources ? changedSince(headPack.meta.analysis) : [];
  if (changed.length > 0) {
    die(`inputs outside the repository have changed since the current pack was analyzed (${changed.join(', ')}). Run \`cascade analyze\`, then compare`);
  }
}

/** The repository holding the project, and the full sha `rev` names in it; a refusal saying why when there is none. */
function commitOf(projectRoot, rev, die) {
  const repoTop = (gitText(projectRoot, ['rev-parse', '--show-toplevel']) ?? '').trim();
  if (!repoTop) die(`${projectRoot} is not in a git repository, so there is no other commit to compare with`);
  const repoRoot = realPath(repoTop);
  const commit = (gitText(repoRoot, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]) ?? '').trim();
  if (!commit) {
    const shallow = (gitText(repoRoot, ['rev-parse', '--is-shallow-repository']) ?? '').trim() === 'true';
    die(`no commit ${JSON.stringify(rev)} in ${repoRoot}${shallow ? '. This clone is shallow and may not hold it: fetch it first (git fetch origin <rev>, or git fetch --unshallow)' : ''}`);
  }
  return { repoRoot, commit };
}

/** The lane flags the current pack was analyzed with, pointed at the worktree. */
export function replayFlags(invocation, { projectRoot, repoRoot, worktreeRoot }, outside) {
  const where = (p) => moveIntoWorktree(path.isAbsolute(p) ? p : path.join(projectRoot, p), { repoRoot, worktreeRoot }, outside);
  const argv = [];
  for (const [key, flag] of [['ddl', '--ddl'], ['mappers', '--mappers'], ['javaSrc', '--java-src'], ['webSrc', '--web-src'], ['openapi', '--openapi'], ['har', '--har'], ['otel', '--otel']]) {
    for (const p of invocation[key] ?? []) argv.push(flag, where(p));
  }
  for (const [key, flag] of [['noDdl', '--no-ddl'], ['noMappers', '--no-mappers'], ['noJava', '--no-java'], ['noWeb', '--no-web'], ['noOpenapi', '--no-openapi']]) {
    if (invocation[key]) argv.push(flag);
  }
  return argv;
}

/** The profile file the current pack read: the one its invocation named, or the one beside the manifest. */
function profileFileOf(invocation, { dotCascade, projectRoot }) {
  if (!invocation.profile) return path.join(dotCascade, 'profile.json');
  return path.isAbsolute(invocation.profile) ? invocation.profile : path.join(projectRoot, invocation.profile);
}

/** This project's manifest and the profile the current pack read, re-pointed into the worktree's `.cascade`. */
export function copyConventions({ dotCascade, target, projectRoot, repoRoot, worktreeRoot, invocation, commit }, outside) {
  const opts = { fromDir: dotCascade, toDir: target, repoRoot, worktreeRoot };
  const profileSrc = profileFileOf(invocation, { dotCascade, projectRoot });
  for (const [src, name] of [[path.join(dotCascade, 'manifest.json'), 'manifest.json'], [profileSrc, 'profile.json']]) {
    // What the current pack did NOT read is replayed too: a profile the commit
    // tracks but the current checkout lacks would read the base another way.
    if (!fs.existsSync(src)) { fs.rmSync(path.join(target, name), { force: true }); continue; }
    // A profile kept outside the repository has no version at that commit: today's is read, and listed.
    if (!inside(realPath(src), repoRoot)) outside.push(realPath(src));
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
}

/** Check the commit out beside the repository, analyze it into scratch, and clean up. */
function buildInWorktree({ commit, dotCascade, repoRoot, projectRoot, invocation, env }) {
  const scratch = realPath(fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-base-')));
  const worktreeRoot = path.join(scratch, 'worktree');
  const add = spawnSync('git', ['-C', repoRoot, 'worktree', 'add', '--detach', worktreeRoot, commit], { encoding: 'utf8' });
  let result;
  let failure = null;
  try {
    if (add.status !== 0) throw new BaseCommitError(`could not check out ${commit.slice(0, 12)} in a worktree: ${tail(add.stderr)}`);
    const worktreeProject = path.join(worktreeRoot, path.relative(repoRoot, projectRoot));
    const target = path.join(worktreeProject, '.cascade');
    fs.mkdirSync(target, { recursive: true });
    const outside = [];
    copyConventions({ dotCascade, target, projectRoot, repoRoot, worktreeRoot, invocation, commit }, outside);
    const flags = replayFlags(invocation, { projectRoot, repoRoot, worktreeRoot }, outside);
    const out = path.join(scratch, 'pack');
    const run = spawnSync(process.execPath, [CLI_PATH, 'analyze', '--root', worktreeProject, '--out', out, ...flags], { encoding: 'utf8', env, maxBuffer: 1 << 26 });
    if (run.status !== 0 || !fs.existsSync(path.join(out, 'pack.json'))) throw new BaseCommitError(`analyzing ${commit.slice(0, 12)} failed:\n${tail(run.stderr)}`);
    result = { pack: JSON.parse(fs.readFileSync(path.join(out, 'pack.json'), 'utf8')), from: 'worktree', commit, outside: [...new Set(outside)].sort() };
  } catch (e) {
    failure = e;
  }
  const leftover = [attempt(() => cleanupWorktree({ repoRoot, worktreeRoot })), attempt(() => { fs.rmSync(scratch, { recursive: true, force: true }); return null; })].filter(Boolean);
  // Both are said: why the base failed, and what is left to clean by hand.
  if (failure && leftover.length) throw new BaseCommitError([failure.message, ...leftover].join('\n'));
  if (failure) throw failure;
  if (leftover.length) throw new BaseCommitError(leftover.join('\n'));
  return result;
}

/** A cleanup step's message: what it returned, or why it threw, so no cleanup error hides the failure before it. */
function attempt(step) {
  try { return step(); } catch (e) { return `cleanup failed: ${e.message}`; }
}

/**
 * Remove the temporary worktree and check that git no longer lists it.
 * @returns {string|null} what is left to clean by hand, or null when nothing is
 */
export function cleanupWorktree({ repoRoot, worktreeRoot, run = spawnSync, rm = fs.rmSync }) {
  run('git', ['-C', repoRoot, 'worktree', 'remove', '--force', worktreeRoot], { encoding: 'utf8' });
  // A list git could not give is not an empty list: it proves nothing was removed.
  const listed = () => {
    const r = run('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
    return r.status !== 0 || String(r.stdout ?? '').split('\n').some((l) => l === `worktree ${worktreeRoot}`);
  };
  if (listed()) {
    rm(worktreeRoot, { recursive: true, force: true });
    run('git', ['-C', repoRoot, 'worktree', 'prune'], { encoding: 'utf8' });
  }
  return listed()
    ? `the temporary worktree ${worktreeRoot} may still be registered in ${repoRoot}. Remove it with: git -C ${repoRoot} worktree remove --force ${worktreeRoot} && git -C ${repoRoot} worktree prune`
    : null;
}
