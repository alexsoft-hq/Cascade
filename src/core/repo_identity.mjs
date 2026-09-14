// repo_identity.mjs — whether two packs were built from the same repository.
//
// WHAT THIS MODULE OWNS. A difference between two packs is a CHANGE only when
// both describe one codebase at two moments. Between two different projects it
// is everything, and a list of a thousand added routes reads like a review while
// meaning nothing. So a comparison asks this first, from what each pack recorded
// about where it was built (`meta.base`), strongest evidence first:
//
//   root commit   the commit the history starts from. Two clones of one
//                 repository share it however far apart their HEADs are, so
//                 equal is the same repository and different is not. A SHALLOW
//                 clone has no real root (its oldest commit is wherever the
//                 clone was cut), so it records none and this step is skipped.
//   remote        the `origin` URL, normalized: scheme, credentials, a trailing
//                 `.git` and letter case do not make two repositories.
//   path          the same checkout on disk.
//   project id    the last resort for packs built before the fields above were
//                 recorded: two ids that differ are two projects.
//
// Nothing here runs git; the analyzer records the fields and this compares them.

/**
 * A remote URL reduced to host and path, so the ways of writing one URL agree.
 * `git@example.com:Org/Repo.git`, `https://user@example.com/org/repo` → `example.com/org/repo`.
 * @param {string|null|undefined} url
 * @returns {string|null}
 */
export function normalizeRemote(url) {
  if (typeof url !== 'string' || url.trim() === '') return null;
  const { scheme, s } = bareRemote(url.trim());
  // The host is case-blind, and the port its scheme uses anyway says nothing; any
  // other port is another server (port 22 under https is not https). The path
  // keeps its case, except on hosts known to ignore it.
  const m = /^([^/:]+)(?::(\d+))?(\/.*)?$/.exec(s);
  if (!m) return s;
  const [host, port, rest = ''] = [m[1].toLowerCase(), m[2] && DEFAULT_PORT[scheme] !== m[2] ? `:${m[2]}` : '', m[3]];
  return `${host}${port}${CASE_BLIND_HOSTS.has(host) ? rest.toLowerCase() : rest}`;
}

/** The port each scheme uses when none is written. The scp form (`user@host:path`) is ssh. */
const DEFAULT_PORT = { https: '443', http: '80', ssh: '22', 'git+ssh': '22', 'ssh+git': '22', git: '9418' };

/** A remote's scheme, and the remote without it, its credentials, a trailing slash or `.git`: `host[:port]/path`. */
function bareRemote(url) {
  // `[user@]host:path` with no scheme: what follows the colon is a path, digits and
  // all (scp has no port), as git reads it.
  const scp = /^[a-z+]+:\/\//i.test(url) ? null : /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(url);
  const scheme = scp ? 'ssh' : (/^([a-z+]+):\/\//i.exec(url)?.[1].toLowerCase() ?? null);
  const noScheme = scp ? `${scp[1]}/${scp[2]}` : url.replace(/^[a-z+]+:\/\//i, '').replace(/^[^@/]+@/, '');
  return { scheme, s: noScheme.replace(/\/+$/, '').replace(/\.git$/i, '') };
}

/** Hosting services whose repository paths ignore letter case. */
const CASE_BLIND_HOSTS = new Set(['github.com', 'gitlab.com', 'bitbucket.org']);

/** What one pack recorded about the repository it was built from. */
export function repositoryOf(pack) {
  const m = pack?.meta ?? {};
  const b = m.base ?? {};
  const projectPath = typeof b.projectPath === 'string' ? b.projectPath : null;
  return { project: m.project ?? null, repoPath: b.repoPath ?? null, rootCommit: b.rootCommit ?? null, remote: storedRemote(b.remote), commit: b.commit ?? null, projectPath };
}

/** The analyzer records the remote already normalized; normalizing it again would read its `host:port/path` as an scp path. */
function storedRemote(remote) {
  return typeof remote === 'string' && remote ? remote : null;
}

/**
 * THE VERDICT: `same`, `different`, or `unknown`, and which evidence decided it.
 * @returns {{verdict:string, by:string|null, base:object, head:object}}
 */
export function sameRepository(basePack, headPack) {
  const a = repositoryOf(basePack);
  const b = repositoryOf(headPack);
  const [by, field] = evidenceFor(a, b);
  if (!field) return { verdict: 'unknown', by: null, base: a, head: b };
  return { verdict: a[field] === b[field] ? 'same' : 'different', by, base: a, head: b };
}

/** Which recorded field decides, strongest first, as `[name, field]`; `[null, null]` when none can. */
const evidenceFor = (a, b) => historyEvidence(a, b) ?? checkoutEvidence(a, b);

/** The root commit, else the remote, when both packs recorded it; null when neither pair is there. */
function historyEvidence(a, b) {
  const field = ['rootCommit', 'remote'].find((f) => a[f] && b[f]);
  if (!field) return null;
  return (a[field] === b[field] && projectEvidence(a, b)) || [field === 'rootCommit' ? 'root commit' : 'remote', field];
}

/**
 * ONE REPOSITORY, TWO PROJECTS: a monorepo keeps several projects in folders of
 * one history, and they share a root commit and a remote. The folder tells them
 * apart. A pack built before the folder was recorded cannot say which project of
 * the repository it is, and two project ids that differ still can.
 */
function projectEvidence(a, b) {
  if (differentFolders(a, b)) return ['project folder', 'projectPath'];
  if (oneFolderUnknown(a, b) && a.project && b.project && a.project !== b.project) return ['project id', 'project'];
  return null;
}

const differentFolders = (a, b) => a.projectPath !== null && b.projectPath !== null && a.projectPath !== b.projectPath;
const oneFolderUnknown = (a, b) => (a.projectPath === null) !== (b.projectPath === null);

/** For packs that recorded no history: the same checkout, or two project ids that differ. */
function checkoutEvidence(a, b) {
  if (a.repoPath && b.repoPath && a.repoPath === b.repoPath) return ['path', 'repoPath'];
  // An equal project id alone proves nothing (an old analyzer named every pack
  // "project"); a different one is enough to say two projects.
  if (a.project && b.project && a.project !== b.project) return ['project id', 'project'];
  return [null, null];
}

/** The sentence a refusal gives: which evidence says the two are not one repository. */
export function differentRepositorySentence(r) {
  const field = { 'root commit': 'rootCommit', remote: 'remote', path: 'repoPath', 'project folder': 'projectPath', 'project id': 'project' }[r.by];
  const val = (side) => JSON.stringify(side[field]);
  const what = r.by === 'project folder' ? 'different projects of one repository' : 'of different repositories';
  return `the two packs are ${what} (${r.by}: ${val(r.base)} and ${val(r.head)}), so their difference is not a change to one codebase. `
    + 'Compare two commits of one project instead: `cascade diff --base-commit <rev>`, or a pack from the project\'s own history';
}
