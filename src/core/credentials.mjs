// credentials.mjs — where a database password lives, and why it lives there.
//
// `cascade catalog fetch` needs one password, once, to read a schema. Until now
// the only place to put it was an environment variable, typed again on every
// run. The obvious alternative — a file under the project's own `.cascade/` —
// is the one place it must never go: a gitignore is a convention, not a
// boundary. Project folders get force-added, zipped, copied to a colleague,
// synced to a cloud drive and mounted into a container, and every one of those
// carries the file along without asking.
//
// So the password lives in the TOOL HOME (`$CASCADE_HOME/credentials`, which is
// `~/.cascade/credentials` unless the environment says otherwise), keyed by the
// server and the user, one JSON object per line, mode 0600. That is what
// `~/.pgpass` and `~/.my.cnf` have done for decades, and the 0600 rule is the
// whole reason the shape is acceptable: a file any other account on the machine
// can read is not a secret, so this module REFUSES to read one rather than
// quietly using it.
//
// JSON per line, rather than the colon-separated `.pgpass` shape, because a
// password may contain any character at all, colons and backslashes included,
// and JSON already says exactly how to write one.
//
// Everything here is a small pure function over text, plus the filesystem edge
// at the bottom (read/write/list/remove). Nothing in this module prints.

import fs from 'node:fs';
import path from 'node:path';
import { homeDir } from './paths.mjs';

/** The file name inside the tool home. */
export const CREDENTIALS_FILE = 'credentials';

/** The mode a credentials file is created with, and the only mode it may have. */
export const CREDENTIALS_MODE = 0o600;

/**
 * Where the credentials file is, for this environment.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function credentialsPath(env = process.env) {
  return path.join(homeDir(env), CREDENTIALS_FILE);
}

/**
 * The KEY half of an entry: which server this password opens. Deliberately the
 * same four fields the fetch confirmation prints, in one string, so a reader can
 * match what `credentials list` shows against what `fetch` said it would dial.
 * No user and no password: those are the other two fields of the entry.
 *
 * @param {{dialect:string, host:string, port:number|string, database:string}} target
 * @returns {string} `<dialect>://<host>:<port>/<database>`
 */
export function serverKey(target) {
  const { dialect, host, port, database } = target ?? {};
  return `${dialect}://${host}:${port}/${database}`;
}

/**
 * Parse the file's text. Every well-formed line becomes an entry; a line that is
 * not a JSON object with the three string fields is REPORTED rather than
 * dropped, because a credentials file somebody hand-edited into nonsense should
 * say so instead of silently losing an entry.
 *
 * @param {string} text
 * @returns {{entries:{server:string,user:string,password:string}[], malformed:number[]}}
 */
export function parseCredentials(text) {
  const entries = [];
  const malformed = [];
  String(text ?? '').split('\n').forEach((line, i) => {
    if (line.trim() === '') return;
    let obj;
    try { obj = JSON.parse(line); } catch { malformed.push(i + 1); return; }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)
      || typeof obj.server !== 'string' || typeof obj.user !== 'string' || typeof obj.password !== 'string') {
      malformed.push(i + 1);
      return;
    }
    entries.push({ server: obj.server, user: obj.user, password: obj.password });
  });
  return { entries, malformed };
}

/**
 * Serialize entries back to file text: one JSON object per line, the fields
 * always in the same order, trailing newline. Two runs that hold the same
 * entries write the same bytes.
 * @param {{server:string,user:string,password:string}[]} entries
 * @returns {string}
 */
export function serializeCredentials(entries) {
  if (entries.length === 0) return '';
  return entries
    .map((e) => JSON.stringify({ server: e.server, user: e.user, password: e.password }))
    .join('\n') + '\n';
}

/**
 * Is `file` inside `projectRoot`? The credentials file must never be, whatever
 * `CASCADE_HOME` says: a secret under an analyzed tree travels with the tree.
 * Both sides are resolved through symlinks as far as they exist, so a temporary
 * directory that is really `/private/tmp/…` compares as itself.
 *
 * @param {string} file
 * @param {string} projectRoot
 * @returns {boolean}
 */
export function isInside(file, projectRoot) {
  const rel = path.relative(realish(projectRoot), realish(file));
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

/**
 * The permission verdict for an existing file: `ok` when no group or other bit
 * is set, and the mode either way as the four digits `chmod` takes.
 * @param {string} file
 * @returns {{exists:boolean, ok:boolean, mode:string|null}}
 */
export function modeVerdict(file) {
  let st;
  try { st = fs.statSync(file); } catch { return { exists: false, ok: true, mode: null }; }
  const bits = st.mode & 0o777;
  return { exists: true, ok: (bits & 0o077) === 0, mode: '0' + bits.toString(8).padStart(3, '0') };
}

// ---------------------------------------------------------------------------
// Filesystem edge.
// ---------------------------------------------------------------------------

/**
 * Read the entries. A missing file is an empty list, not an error: nobody has
 * saved a password yet. A file readable by group or others is an ERROR carrying
 * the exact `chmod` to run.
 *
 * @param {string} file
 * @returns {{entries:{server:string,user:string,password:string}[], malformed:number[], exists:boolean}}
 */
export function readCredentials(file) {
  const verdict = modeVerdict(file);
  if (!verdict.exists) return { entries: [], malformed: [], exists: false };
  if (!verdict.ok) throw new CredentialsError(permissionMessage(file, verdict.mode));
  const { entries, malformed } = parseCredentials(fs.readFileSync(file, 'utf8'));
  return { entries, malformed, exists: true };
}

/**
 * The password for one server and user, or null. Same permission rule as
 * `readCredentials` — this is the read that matters.
 * @param {string} file
 * @param {string} server
 * @param {string} user
 * @returns {string|null}
 */
export function findPassword(file, server, user) {
  const { entries } = readCredentials(file);
  const hit = entries.find((e) => e.server === server && e.user === user);
  return hit ? hit.password : null;
}

/**
 * Server and user of every entry, in file order. NEVER the password: this is
 * what `credentials list` prints, and the shape is what makes that safe.
 * @param {string} file
 * @returns {{server:string, user:string}[]}
 */
export function listCredentials(file) {
  return readCredentials(file).entries.map((e) => ({ server: e.server, user: e.user }));
}

/**
 * Store one password, replacing the entry for the same server and user IN
 * PLACE (so a re-save does not leave the old password behind on an earlier
 * line). The file is created 0600 and re-chmodded on every write, because a
 * `umask` that widened it once would otherwise widen it forever.
 *
 * @param {string} file
 * @param {{server:string, user:string, password:string}} entry
 * @returns {{replaced:boolean, file:string}}
 */
export function setCredential(file, entry) {
  const { server, user, password } = entry;
  const { entries } = readCredentials(file);
  const at = entries.findIndex((e) => e.server === server && e.user === user);
  const replaced = at >= 0;
  if (replaced) entries[at] = { server, user, password };
  else entries.push({ server, user, password });
  writeCredentials(file, entries);
  return { replaced, file };
}

/**
 * Delete the entry for one server and user. Exactly one: an entry for the same
 * server under another user stays.
 * @param {string} file
 * @param {string} server
 * @param {string} user
 * @returns {{removed:boolean, remaining:number}}
 */
export function removeCredential(file, server, user) {
  const { entries, exists } = readCredentials(file);
  if (!exists) return { removed: false, remaining: 0 };
  const kept = entries.filter((e) => !(e.server === server && e.user === user));
  if (kept.length === entries.length) return { removed: false, remaining: entries.length };
  writeCredentials(file, kept);
  return { removed: true, remaining: kept.length };
}

/**
 * Write the whole file, atomically, at mode 0600. The temporary file is created
 * 0600 too, so there is no instant at which the password is readable by anyone
 * else even under a permissive umask.
 * @param {string} file
 * @param {{server:string,user:string,password:string}[]} entries
 */
export function writeCredentials(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w', CREDENTIALS_MODE);
  try {
    fs.writeFileSync(fd, serializeCredentials(entries), 'utf8');
    fs.fchmodSync(fd, CREDENTIALS_MODE);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  fs.chmodSync(file, CREDENTIALS_MODE);
}

/**
 * The refusal sentence, with the exact command that fixes it. Exported so the
 * CLI and the tests quote the same words.
 * @param {string} file
 * @param {string|null} mode
 * @returns {string}
 */
export function permissionMessage(file, mode) {
  return `the credentials file ${file} is mode ${mode ?? 'unknown'}, which lets other accounts on this machine read it.\n`
    + '  A password in a file anyone can open is not a secret, so it is refused rather than used.\n'
    + `  Run: chmod 600 ${file}`;
}

/** Resolve as much of a path as exists through its symlinks; the rest stays as written. */
function realish(p) {
  let cur = path.resolve(p);
  const tail = [];
  for (;;) {
    try {
      const base = fs.realpathSync(cur);
      return tail.length === 0 ? base : path.join(base, ...tail.slice().reverse());
    } catch { /* this segment does not exist yet; try the parent */ }
    const parent = path.dirname(cur);
    if (parent === cur) return path.resolve(p);
    tail.push(path.basename(cur));
    cur = parent;
  }
}

export class CredentialsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CredentialsError';
  }
}
