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
  let s = url.trim();
  const scp = /^[^@/]+@([^:/]+):(.+)$/.exec(s);
  if (scp) s = `${scp[1]}/${scp[2]}`;
  else s = s.replace(/^[a-z+]+:\/\//i, '').replace(/^[^@/]+@/, '');
  s = s.replace(/\/+$/, '').replace(/\.git$/i, '').replace(/:\d+\//, '/');
  return s.toLowerCase();
}

/** What one pack recorded about the repository it was built from. */
export function repositoryOf(pack) {
  const m = pack?.meta ?? {};
  const b = m.base ?? {};
  return {
    project: m.project ?? null,
    repoPath: b.repoPath ?? null,
    rootCommit: b.rootCommit ?? null,
    remote: normalizeRemote(b.remote ?? null),
    commit: b.commit ?? null,
  };
}

/**
 * THE VERDICT: `same`, `different`, or `unknown`, and which evidence decided it.
 * @returns {{verdict:string, by:string|null, base:object, head:object}}
 */
export function sameRepository(basePack, headPack) {
  const a = repositoryOf(basePack);
  const b = repositoryOf(headPack);
  const decide = (by, x, y) => ({ verdict: x === y ? 'same' : 'different', by, base: a, head: b });
  if (a.rootCommit && b.rootCommit) return decide('root commit', a.rootCommit, b.rootCommit);
  if (a.remote && b.remote) return decide('remote', a.remote, b.remote);
  if (a.repoPath && b.repoPath && a.repoPath === b.repoPath) return decide('path', a.repoPath, b.repoPath);
  if (a.project && b.project) return decide('project id', a.project, b.project);
  return { verdict: 'unknown', by: null, base: a, head: b };
}

/** The sentence a refusal gives: which evidence says the two are not one repository. */
export function differentRepositorySentence(r) {
  const val = (side) => (r.by === 'root commit' ? side.rootCommit : r.by === 'remote' ? side.remote : r.by === 'path' ? side.repoPath : side.project);
  return `the two packs are of different repositories (${r.by}: ${val(r.base)} and ${val(r.head)}), so their difference is not a change to one codebase. `
    + 'Compare two commits of one project instead: `cascade diff --base-commit <rev>`, or a pack from the project\'s own history';
}
