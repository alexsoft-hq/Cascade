#!/usr/bin/env node
// check-dco.mjs — every commit in a range carries a Signed-off-by trailer whose
// e-mail is the author's (the Developer Certificate of Origin 1.1; see ./DCO).
//
// WHY THE E-MAIL HAS TO MATCH: a sign-off is a statement made BY the author
// about their own right to submit the work. `Signed-off-by: Someone Else
// <someone@else>` on a commit authored by a third party certifies nothing about
// that commit, and a check that accepts any trailer at all is a check that only
// verifies the contributor knows how to type one.
//
// The comparison is on the e-mail, case-insensitively, and NOT on the name:
// people spell their own names differently in `user.name` and in a trailer far
// more often than they use a different address, and the address is the part
// that identifies.
//
// USAGE
//   node scripts/check-dco.mjs                          # origin/main..HEAD
//   node scripts/check-dco.mjs --range <base>..<head>
//   node scripts/check-dco.mjs --commits <sha> [<sha>…]
//   node scripts/check-dco.mjs --repo <dir> …           # a repository other than cwd
//   node scripts/check-dco.mjs --json
//
// EXIT 0 when every commit in the range signs off; 1 when any does not (the
// offending SHAs are printed); 2 when the range itself cannot be read — a
// missing base ref is not "no unsigned commits".

import { execFileSync } from 'node:child_process';

const DEFAULT_RANGE = 'origin/main..HEAD';

/** Merge commits are skipped: a merge is not a contribution, it is a join. */
const REV_LIST_ARGS = ['--no-merges'];

/**
 * The unit separator record format: sha, author name, author e-mail, body.
 * NUL-delimited fields and a record terminator that cannot occur in a commit
 * message, so a body containing anything at all still parses.
 */
const FORMAT = '%H%x00%an%x00%ae%x00%B%x00%x00';

export class DcoError extends Error {}

/**
 * Every `Signed-off-by:` trailer in a commit message, as {name, email}.
 * Tolerant of the spellings git itself accepts: any case, extra spaces.
 * @param {string} body
 * @returns {{name:string, email:string}[]}
 */
export function signOffs(body) {
  const out = [];
  for (const line of String(body ?? '').split('\n')) {
    const m = /^\s*signed-off-by:\s*(.*?)\s*<([^>]*)>\s*$/i.exec(line);
    if (m) out.push({ name: m[1], email: m[2].trim() });
  }
  return out;
}

/**
 * Decide one commit. PURE — the git reading happens in the caller.
 * @param {{sha:string, authorName:string, authorEmail:string, body:string}} commit
 * @returns {{sha:string, ok:boolean, reason:(string|null), signOffs:{name:string,email:string}[]}}
 */
export function checkCommit(commit) {
  const offs = signOffs(commit.body);
  const want = String(commit.authorEmail ?? '').trim().toLowerCase();
  if (offs.length === 0) {
    return { sha: commit.sha, ok: false, signOffs: offs, reason: 'no Signed-off-by trailer' };
  }
  if (offs.some((s) => s.email.toLowerCase() === want)) {
    return { sha: commit.sha, ok: true, signOffs: offs, reason: null };
  }
  return {
    sha: commit.sha,
    ok: false,
    signOffs: offs,
    reason: `signed off by ${offs.map((s) => `<${s.email}>`).join(', ')} but authored by <${commit.authorEmail}>`,
  };
}

/**
 * The verdict over a list of commits. PURE.
 * @param {{sha:string, authorName:string, authorEmail:string, body:string}[]} commits
 * @returns {{schema:string, commits:object[], failed:object[], ok:boolean, checked:number}}
 */
export function checkCommits(commits) {
  const results = commits.map(checkCommit);
  const failed = results.filter((r) => !r.ok);
  return {
    schema: 'cascade:dco-check:1',
    commits: results,
    failed,
    ok: failed.length === 0,
    checked: results.length,
  };
}

/**
 * Read commits out of a repository. The ONE impure function here.
 * @param {{repo?:string, range?:string, commits?:string[]}} opts
 * @returns {{sha:string, authorName:string, authorEmail:string, body:string}[]}
 */
export function readCommits(opts = {}) {
  const repo = opts.repo ?? process.cwd();
  const args = ['-C', repo, 'log', `--format=${FORMAT}`, ...REV_LIST_ARGS];
  if (opts.commits && opts.commits.length > 0) args.push('--no-walk', ...opts.commits);
  else args.push(opts.range ?? DEFAULT_RANGE);

  let raw;
  try {
    raw = execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const said = String((e && e.stderr) || '').trim().split('\n').filter(Boolean).pop();
    throw new DcoError(
      `cannot read ${opts.commits ? 'those commits' : `the range ${opts.range ?? DEFAULT_RANGE}`} in ${repo}: `
      + `${said || (e && e.message) || 'git failed'}\n`
      + '  (in CI, check out with fetch-depth: 0 — a shallow clone has no base ref to diff against)',
    );
  }

  // Fields are separated by one 0x00 and records by two. Both are written as
  // ESCAPES: no source file in this repository carries a literal NUL byte.
  const FIELD = '\u0000';
  const RECORD = '\u0000\u0000';
  return raw
    .split(RECORD)
    .map((rec) => rec.replace(/^\n/, ''))
    .filter((rec) => rec.length > 0)
    .map((rec) => {
      const [sha, authorName, authorEmail, body] = rec.split(FIELD);
      return { sha, authorName, authorEmail, body: body ?? '' };
    });
}

/** The human report for a verdict. Returned, not printed. */
export function formatDcoReport(verdict) {
  if (verdict.checked === 0) return 'DCO: no commits in range — nothing to check\n';
  if (verdict.ok) return `DCO: ${verdict.checked} commit(s) signed off\n`;
  const lines = [`DCO: ${verdict.failed.length} of ${verdict.checked} commit(s) are not signed off:`];
  for (const f of verdict.failed) lines.push(`  ${f.sha}  ${f.reason}`);
  lines.push('');
  lines.push('Every commit must carry a Signed-off-by trailer with the author\'s own e-mail — see ./DCO.');
  lines.push('  git commit -s                      (on the next commit)');
  lines.push('  git commit --amend -s --no-edit    (to fix the last one)');
  lines.push('  git rebase --signoff <base>        (to fix a whole branch)');
  return lines.join('\n') + '\n';
}

// --- CLI -------------------------------------------------------------------
if (process.argv[1] && process.argv[1].endsWith('check-dco.mjs')) {
  const argv = process.argv.slice(2);
  const opt = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
  };
  const commitsAt = argv.indexOf('--commits');
  const commits = commitsAt >= 0
    ? argv.slice(commitsAt + 1).filter((a) => !a.startsWith('--'))
    : null;

  try {
    const verdict = checkCommits(readCommits({
      repo: opt('repo') ?? process.cwd(),
      range: opt('range') ?? DEFAULT_RANGE,
      commits,
    }));
    process.stdout.write(argv.includes('--json')
      ? JSON.stringify(verdict, null, 2) + '\n'
      : formatDcoReport(verdict));
    process.exit(verdict.ok ? 0 : 1);
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(2);
  }
}
