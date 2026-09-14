// pack_history.mjs — the project's own earlier packs, kept so a change can be compared with what was there before.
//
// `cascade analyze` writes `.cascade/pack/pack.json` and, until now, the pack it
// replaced was gone. A comparison between two commits of one project then had
// nothing to compare with unless somebody had copied the old pack by hand. So a
// certified run moves the pack it is about to replace into `.cascade/history/`,
// one directory per build, and keeps the most recent few. A rejected run, a
// one-off `--out` build and a rebuild that changed nothing (same commit, same
// digest) keep nothing.
//
// Every entry is a pack of THIS project, which is what makes it a fair base: the
// Compare tab and `pack_diff { base_commit }` choose only from here.

import fs from 'node:fs';
import path from 'node:path';

/** How many earlier packs are kept. A large pack is tens of megabytes. */
export const HISTORY_KEEP = 5;

const INDEX = 'index.json';
const SCHEMA = 'cascade:pack-history:1';

/** The history directory beside a pack directory. */
export const historyDirOf = (packDir) => path.join(path.dirname(path.resolve(packDir)), 'history');

function readIndex(dir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, INDEX), 'utf8'));
    return j && j.schema === SCHEMA && Array.isArray(j.entries) ? j.entries : [];
  } catch { return []; }
}

function writeIndex(dir, entries) {
  const tmp = path.join(dir, `${INDEX}.tmp-${process.pid}`);
  fs.writeFileSync(tmp, `${JSON.stringify({ schema: SCHEMA, entries }, null, 2)}\n`);
  fs.renameSync(tmp, path.join(dir, INDEX));
}

/** One entry's line in the index: enough to choose it without opening the pack. */
function entryOf(id, meta, digest) {
  const b = meta?.base ?? {};
  return { id, commit: b.commit ?? null, dirty: b.dirty === true, builtAt: meta?.builtAt ?? null, digest: digest ?? null, project: meta?.project ?? null };
}

/**
 * Move the pack a certified run is about to replace into the history, unless it
 * is the same build. Called before the new pack is written.
 * @returns {object|null} the entry kept, or null when nothing was kept
 */
export function archivePreviousPack(packDir, next) {
  const file = path.join(packDir, 'pack.json');
  if (!fs.existsSync(file)) return null;
  let prev;
  try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  const sameBuild = prev.digest === next.digest && (prev.meta?.base?.commit ?? null) === (next.meta?.base?.commit ?? null);
  if (sameBuild) return null;
  const dir = historyDirOf(packDir);
  const id = `${String(prev.meta?.base?.commit ?? 'no-commit').slice(0, 12)}-${prev.digest}`;
  fs.mkdirSync(path.join(dir, id), { recursive: true });
  fs.renameSync(file, path.join(dir, id, 'pack.json'));
  const entries = [entryOf(id, prev.meta, prev.digest), ...readIndex(dir).filter((e) => e.id !== id)];
  for (const old of entries.slice(HISTORY_KEEP)) fs.rmSync(path.join(dir, old.id), { recursive: true, force: true });
  writeIndex(dir, entries.slice(0, HISTORY_KEEP));
  return entries[0];
}

/** The kept packs, newest first. */
export function listHistory(packDir) {
  return readIndex(historyDirOf(packDir)).filter((e) => fs.existsSync(path.join(historyDirOf(packDir), e.id, 'pack.json')));
}

/**
 * One kept pack, by its id or by a commit it was built at (a prefix of at least
 * seven characters). A commit several kept packs share picks the newest clean one.
 * @returns {{entry:object, pack:object}|null}
 */
export function loadHistoryPack(packDir, { id = null, commit = null } = {}) {
  const entries = listHistory(packDir);
  const want = id
    ? entries.find((e) => e.id === id)
    : commit && commit.length >= 7
      ? (entries.filter((e) => e.commit && e.commit.startsWith(commit)).sort((a, b) => Number(a.dirty) - Number(b.dirty))[0] ?? null)
      : null;
  if (!want) return null;
  return { entry: want, pack: JSON.parse(fs.readFileSync(path.join(historyDirOf(packDir), want.id, 'pack.json'), 'utf8')) };
}
