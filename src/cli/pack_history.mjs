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
// on the lock, so neither can move a pack the other is about to keep.
//
// AN INDEX IS DATA, NOT A LIST OF PATHS TO DELETE. Every entry's id is checked
// against the one shape this module writes before anything is copied or
// removed, so a damaged or edited index cannot point a removal outside the
// history directory; an index that cannot be read is rebuilt from the
// directories rather than forgotten.

import fs from 'node:fs';
import path from 'node:path';

/** How many earlier packs are kept. A large pack is tens of megabytes. */
export const HISTORY_KEEP = 5;

const INDEX = 'index.json';
const SCHEMA = 'cascade:pack-history:1';
/** The only id this module writes: up to 12 hex of the commit (or `no-commit`), and the 12-hex digest. */
const ID_RE = /^(?:[0-9a-f]{1,12}|no-commit)-[0-9a-f]{12}$/;
/** How long a lock may stand before it is taken to belong to a run that died. */
const LOCK_STALE_MS = 15 * 60 * 1000;
const LOCK_WAIT_MS = 60 * 1000;

/** The history directory beside a pack directory. */
export const historyDirOf = (packDir) => path.join(path.dirname(path.resolve(packDir)), 'history');

const validEntry = (e) => e && typeof e === 'object' && typeof e.id === 'string' && ID_RE.test(e.id);

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
    if (j && j.schema === SCHEMA && Array.isArray(j.entries) && j.entries.every(validEntry)) return j.entries;
  } catch { /* rebuilt below */ }
  return scanEntries(dir);
}

/** Write a file by renaming a finished copy over it, so a reader sees the old bytes or the new ones. */
export function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/** Take the lock file, waiting for a live holder and breaking a dead one's. */
function acquireLock(lock, { until, staleMs, log }) {
  for (;;) {
    try { return fs.openSync(lock, 'wx'); } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let age;
      try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { continue; }
      if (age > staleMs) { log(`pack lock ${lock} is ${Math.round(age / 1000)}s old, so the run that took it is gone: breaking it`); fs.rmSync(lock, { force: true }); continue; }
      if (Date.now() > until) throw new Error(`another analyze of this project holds ${lock}; wait for it to finish, or remove the file if no analyze is running`, { cause: e });
      sleepMs(250);
    }
  }
}

const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * The project's write lock, held for the time `fn` runs. A lock older than a run
 * could last is taken to be a dead run's and is broken, and saying so.
 */
export function withPackLock(packDir, fn, { waitMs = LOCK_WAIT_MS, staleMs = LOCK_STALE_MS, log = (s) => process.stderr.write(`${s}\n`) } = {}) {
  fs.mkdirSync(packDir, { recursive: true });
  const lock = path.join(packDir, '.write.lock');
  const fd = acquireLock(lock, { until: Date.now() + waitMs, staleMs, log });
  try {
    fs.writeSync(fd, String(process.pid));
    return fn();
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lock, { force: true });
  }
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
  fs.mkdirSync(path.join(dir, id), { recursive: true });
  fs.copyFileSync(file, path.join(dir, id, 'pack.json'));
  const entries = [entryOf(id, prev.meta, prev.digest), ...readIndex(dir).filter((e) => e.id !== id)];
  writeAtomic(path.join(dir, INDEX), `${JSON.stringify({ schema: SCHEMA, entries }, null, 2)}\n`);
  return entries[0];
}

/** Remove what is past the kept count. Called after the new pack is in place. */
export function pruneHistory(packDir, keep = HISTORY_KEEP) {
  const dir = historyDirOf(packDir);
  const entries = readIndex(dir);
  for (const old of entries.slice(keep)) {
    const target = path.resolve(dir, old.id);
    if (!ID_RE.test(old.id) || path.dirname(target) !== path.resolve(dir)) continue;
    fs.rmSync(target, { recursive: true, force: true });
  }
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
  const pack = JSON.parse(fs.readFileSync(path.join(historyDirOf(packDir), want.id, 'pack.json'), 'utf8'));
  if (pack.digest !== want.digest || (pack.meta?.base?.commit ?? null) !== want.commit) return null;
  return { entry: want, pack };
}
