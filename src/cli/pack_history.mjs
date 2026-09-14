// pack_history.mjs — the project's own earlier packs, kept so a change can be compared with what was there before.
//
// `cascade analyze` writes `.cascade/pack/pack.json` and, until now, the pack it
// replaced was gone. A comparison between two commits of one project then had
// nothing to compare with unless somebody had copied the old pack by hand. So a
// certified run keeps a COPY of the pack it is about to replace in
// `.cascade/history/`, one directory per build, and keeps the most recent few.
// A rejected run, a one-off `--out` build and a rebuild that changed nothing
// (same commit, same digest) keep nothing.
//
// THE PACK BEING SERVED IS NEVER AT RISK. The order is: take the project's write
// lock, copy the current pack into the history, write the new pack beside the old
// one and rename it over it in one step, and only then prune the history. A
// failure while keeping or pruning is a warning, and the served pack is either the
// old one or the new one, never neither. Two analyses of one project take turns
// on the lock, so neither can move a pack the other is about to keep. A lock is
// never broken automatically: two runs that both judged it abandoned would both
// break it and both publish. It covers seconds of writing, so one that stays is
// a run killed while publishing, and the refusal says how to remove it.
//
// AN INDEX IS DATA, NOT A LIST OF PATHS TO DELETE. Every entry's id is checked
// against the one shape this module writes before anything is copied or
// removed, so a damaged or edited index cannot point a removal outside the
// history directory; an index that cannot be read is rebuilt from the
// directories rather than forgotten.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** How many earlier packs are kept. A large pack is tens of megabytes. */
export const HISTORY_KEEP = 5;

const INDEX = 'index.json';
const SCHEMA = 'cascade:pack-history:1';
/** The only id this module writes: up to 12 hex of the commit (or `no-commit`), and the 12-hex digest. */
const ID_RE = /^(?:[0-9a-f]{1,12}|no-commit)-[0-9a-f]{12}$/;
const LOCK_WAIT_MS = 60 * 1000;

/** The history directory beside a pack directory. */
export const historyDirOf = (packDir) => path.join(path.dirname(path.resolve(packDir)), 'history');

const validEntry = (e) => e && typeof e === 'object' && typeof e.id === 'string' && ID_RE.test(e.id)
  && (e.commit === null || typeof e.commit === 'string') && typeof e.dirty === 'boolean' && e.id.endsWith(`-${e.digest}`);

/** One entry's line in the index: enough to choose it without opening the pack. */
function entryOf(id, meta, digest) {
  const b = meta?.base ?? {};
  return { id, commit: b.commit ?? null, dirty: b.dirty === true, builtAt: meta?.builtAt ?? null, digest: digest ?? null, project: meta?.project ?? null };
}

/** The entries a directory scan finds, newest first: what an unreadable index is rebuilt from. */
function scanEntries(dir) {
  let names;
  try { names = fs.readdirSync(dir).filter((n) => ID_RE.test(n)); } catch { return []; }
  const out = [];
  for (const id of names) {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(dir, id, 'pack.json'), 'utf8'));
      // The directory's name carries the digest it was kept under; a pack that no longer has it is not that build.
      if (id.endsWith(`-${p.digest}`)) out.push(entryOf(id, p.meta, p.digest));
    } catch { /* a directory with no readable pack is not an entry */ }
  }
  return out.sort((a, b) => String(b.builtAt).localeCompare(String(a.builtAt)));
}

function readIndex(dir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, INDEX), 'utf8'));
    // One entry per id: a kept set and a pruned set that share an id would delete a build the index still lists.
    const unique = (es) => new Set(es.map((e) => e.id)).size === es.length;
    if (j && j.schema === SCHEMA && Array.isArray(j.entries) && j.entries.every(validEntry) && unique(j.entries)) return j.entries;
  } catch { /* rebuilt below */ }
  return scanEntries(dir);
}

/** Write a file by renaming a finished copy over it, so a reader sees the old bytes or the new ones. */
export function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch (e) {
    // The failure that matters is the write's; a temp file that will not go is only added to it.
    try { fs.rmSync(tmp, { force: true }); } catch (cleanup) { e.message += ` (and ${tmp} could not be removed: ${cleanup.message})`; }
    throw e;
  }
}

/** Take the lock file, waiting for its holder; a refusal that names the holder when the wait runs out. */
function acquireLock(lock, { until }) {
  for (;;) {
    try { return fs.openSync(lock, 'wx'); } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (Date.now() > until) throw new Error(`${holderOf(lock)} holds ${lock}. Wait for it to finish; if no analyze of this project is running (one was killed while publishing), remove the file`, { cause: e });
      sleepMs(250);
    }
  }
}

/** Who a lock says holds it, for the refusal: the process id and whether it is still running on this machine. */
function holderOf(lock) {
  let pid = null;
  try { pid = Number.parseInt(fs.readFileSync(lock, 'utf8'), 10); } catch { /* gone or unreadable */ }
  if (!Number.isInteger(pid) || pid <= 0) return 'another analyze of this project';
  try { process.kill(pid, 0); return `analyze process ${pid} (running)`; } catch (e) { return `analyze process ${pid} (${e.code === 'ESRCH' ? 'not running' : 'state unknown'})`; }
}

const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * The project's write lock, held for the time `fn` runs: only the publish, which
 * takes seconds. Each holder writes its own token and removes the lock only while
 * the token is still its own, so a lock somebody removed by hand and another run
 * took is not removed from under that run.
 */
export function withPackLock(packDir, fn, { waitMs = LOCK_WAIT_MS } = {}) {
  fs.mkdirSync(packDir, { recursive: true });
  const lock = path.join(packDir, '.write.lock');
  const fd = acquireLock(lock, { until: Date.now() + waitMs });
  const token = `${process.pid}:${crypto.randomUUID()}`;
  try {
    fs.writeSync(fd, token);
    return fn();
  } finally {
    fs.closeSync(fd);
    releaseLock(lock, token);
  }
}

/** Remove the lock while it is still this holder's. */
function releaseLock(lock, token) {
  let holder = null;
  try { holder = fs.readFileSync(lock, 'utf8'); } catch { /* already gone */ }
  if (holder === token) fs.rmSync(lock, { force: true });
}

/** The id a pack is kept under, or null for a pack with no digest this module can name. */
function historyIdOf(pack) {
  if (typeof pack.digest !== 'string' || !/^[0-9a-f]{12}$/.test(pack.digest)) return null;
  const commit = String(pack.meta?.base?.commit ?? '');
  return `${/^[0-9a-f]{7,}$/.test(commit) ? commit.slice(0, 12) : 'no-commit'}-${pack.digest}`;
}

/** The same build twice: one digest at one commit. */
const sameBuild = (a, b) => a.digest === b.digest && (a.meta?.base?.commit ?? null) === (b.meta?.base?.commit ?? null);

/**
 * Copy the pack a certified run is about to replace into the history, unless it
 * is the same build. Called under the lock, before the new pack is written.
 * @returns {object|null} the entry kept, or null when nothing was kept
 */
export function keepPreviousPack(packDir, next) {
  const file = path.join(packDir, 'pack.json');
  if (!fs.existsSync(file)) return null;
  let prev;
  try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  const id = historyIdOf(prev);
  if (!id || sameBuild(prev, next)) return null;
  const dir = historyDirOf(packDir);
  const entries = [entryOf(id, prev.meta, prev.digest), ...readIndex(dir).filter((e) => e.id !== id)];
  copyIntoHistory(dir, id, file, entries);
  return entries[0];
}

/**
 * The copy and the index line that lists it. A build already kept under this id
 * (the same build kept once before) is used as it is; a new copy is made in a
 * staging directory and renamed into place whole. A failure removes only what
 * THIS call made, never a build that was there before it.
 */
function copyIntoHistory(dir, id, file, entries) {
  if (!keptIntact(path.join(dir, id), id)) stageCopy(dir, id, file);
  writeAtomic(path.join(dir, INDEX), `${JSON.stringify({ schema: SCHEMA, entries }, null, 2)}\n`);
}

/** A new copy, made whole beside the history and renamed into place; on failure only the staging copy goes. */
function stageCopy(dir, id, file) {
  const [target, staging] = [path.join(dir, id), path.join(dir, `${STAGING}${id}-${process.pid}`)];
  try {
    fs.mkdirSync(staging, { recursive: true });
    fs.copyFileSync(file, path.join(staging, 'pack.json'));
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(staging, target);
  } catch (e) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw e;
  }
}

const STAGING = '.staging-';

/** Whether a kept directory holds the build its id names. */
function keptIntact(target, id) {
  try { return id.endsWith(`-${JSON.parse(fs.readFileSync(path.join(target, 'pack.json'), 'utf8')).digest}`); } catch { return false; }
}

/**
 * A directory this module made and the index no longer lists: a build id's shape
 * holding nothing but a pack, or a staging directory left by a run that died.
 * Anything else in the history directory is not this module's to remove.
 */
function removableLeftover(dir, name, kept) {
  if (name.startsWith(STAGING)) return true;
  if (!ID_RE.test(name) || kept.has(name)) return false;
  try { return fs.readdirSync(path.join(dir, name)).every((n) => n === 'pack.json'); } catch { return false; }
}

/** Remove what is past the kept count. Called after the new pack is in place. */
export function pruneHistory(packDir, keep = HISTORY_KEEP) {
  const dir = historyDirOf(packDir);
  if (!fs.existsSync(dir)) return;
  const entries = readIndex(dir);
  const kept = new Set(entries.slice(0, keep).map((e) => e.id));
  // Past the kept count, and any build directory the index does not list: only
  // what this module made (runs of one project take turns on the lock, so no
  // other run is staging a copy meanwhile).
  const names = fs.readdirSync(dir).filter((n) => removableLeftover(dir, n, kept));
  for (const name of names) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  writeAtomic(path.join(dir, INDEX), `${JSON.stringify({ schema: SCHEMA, entries: entries.slice(0, keep) }, null, 2)}\n`);
}

/** The kept packs, newest first. */
export function listHistory(packDir) {
  const dir = historyDirOf(packDir);
  return readIndex(dir).filter((e) => fs.existsSync(path.join(dir, e.id, 'pack.json')));
}

/** The entry an id names, or the clean build a commit prefix of seven or more characters names. */
function pickEntry(entries, { id, commit }) {
  if (id) return entries.find((e) => e.id === id) ?? null;
  if (!commit || commit.length < 7) return null;
  return entries.find((e) => !e.dirty && e.commit && e.commit.startsWith(commit)) ?? null;
}

/**
 * One kept pack, by its id, or by a commit it was built at (a prefix of at least
 * seven characters). A commit names a CLEAN build only: a build made with
 * uncommitted edits is not that commit, and is chosen by its id or not at all.
 * The pack read must be the one the index says, or it is not returned.
 * @returns {{entry:object, pack:object}|null}
 */
export function loadHistoryPack(packDir, { id = null, commit = null } = {}) {
  const want = pickEntry(listHistory(packDir), { id, commit });
  if (!want) return null;
  const pack = readKept(packDir, want.id);
  return pack && sameEntry(pack, want) ? { entry: want, pack } : null;
}

/** A kept pack, or null when it is gone (pruned by another run since the index was read) or unreadable. */
function readKept(packDir, id) {
  try { return JSON.parse(fs.readFileSync(path.join(historyDirOf(packDir), id, 'pack.json'), 'utf8')); } catch { return null; }
}

/** Whether the pack is the build its entry names: its digest, its commit, and whether it was clean. */
function sameEntry(pack, entry) {
  const b = pack.meta?.base ?? {};
  return pack.digest === entry.digest && (b.commit ?? null) === entry.commit && (b.dirty === true) === entry.dirty;
}
