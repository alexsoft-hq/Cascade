// doctor.mjs — the prerequisite pre-flight (SPEC §17.9).
//
// WHY IT EXISTS: every prerequisite this engine has used to be discoverable only
// by hitting the error it produces. A missing `sqlglot` surfaced three screens
// into `analyze`; a missing JDK surfaced only once the Java lane was selected;
// nothing at all told you the cache directory was unwritable until a shard
// failed to land. §17.9 asks for ONE report that names every prerequisite, its
// state, and the remedy — before anything is run.
//
// PURE. This module computes the report from PROBES the caller has already
// collected. It runs no process, reads no file and touches no environment, so
// the whole table can be tested with fake probes (`test/doctor.test.mjs`), which
// is the only way to test the shapes a developer machine does not happen to be
// in (no JDK, an unwritable cache, a driver installed but broken).
//
// THE JDK LOOKUP IS SHARED, NOT COPIED. `jdkCandidateDirs()` below is the ONE
// ordered list of directories the engine looks in; `bin/cascade.mjs` (the Java
// lane) and `scripts/ci-java-smoke.mjs` both walk it, so what doctor reports is
// what `analyze` will do rather than a second opinion about it.

/** Schema identifier for the `--json` report (SPEC §18.1). */
export const DOCTOR_SCHEMA = 'cascade:doctor:1';

/** The lowest Node this engine is tested on (`package.json` engines.node). */
export const MIN_NODE_MAJOR = 20;

/**
 * The directories a JDK is looked for in, in order, each with the reason it is
 * on the list. Pure: it reads `env`, never the filesystem.
 *
 * The order is deliberate — an explicitly exported `JAVA_HOME` beats anything a
 * package manager happens to have left on the machine, and PATH comes last so a
 * shim cannot quietly win over a JDK the user pointed at.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {{dir:string, via:string}[]}  `dir === null` marks the PATH fallback
 */
export function jdkCandidateDirs(env = {}) {
  const out = [];
  if (env.JAVA_HOME) out.push({ dir: `${env.JAVA_HOME}/bin`, via: 'JAVA_HOME' });
  if (env.SDKMAN_CANDIDATES_DIR) out.push({ dir: `${env.SDKMAN_CANDIDATES_DIR}/java/current/bin`, via: 'SDKMAN_CANDIDATES_DIR' });
  if (env.HOME) out.push({ dir: `${env.HOME}/.sdkman/candidates/java/current/bin`, via: 'sdkman' });
  out.push({ dir: '/usr/lib/jvm/default-java/bin', via: 'debian default-java' });
  out.push({ dir: '/opt/homebrew/opt/openjdk/bin', via: 'homebrew keg (arm64)' });
  out.push({ dir: '/usr/local/opt/openjdk/bin', via: 'homebrew keg (x86_64)' });
  return out;
}

/** `ok` — present and usable. `warn` — present but not what we want. `missing` — absent. */
export const STATUSES = Object.freeze(['ok', 'warn', 'missing']);

const check = (id, label, required, status, detail, remedy) => ({ id, label, required, status, detail, remedy });

/** Major version out of `v20.11.1` / `20.11.1`, or null when unreadable. */
function majorOf(version) {
  const m = /^v?(\d+)\./.exec(String(version ?? ''));
  return m ? Number(m[1]) : null;
}

/**
 * Build the doctor report from collected probes.
 *
 * Every field is optional: a probe the caller could not run at all arrives as
 * `undefined` and becomes `missing` with the remedy that would have made it
 * runnable — never a silent pass.
 *
 * @param {{
 *   node?: {version?:string},
 *   git?: {ok?:boolean, version?:string, error?:string},
 *   python?: {path?:string, ok?:boolean, version?:string, error?:string},
 *   sqlglot?: {ok?:boolean, version?:string, error?:string},
 *   jdk?: {candidates?:{dir:string, via:string, javac:boolean, java:boolean}[],
 *          chosen?:{javac:string, java:string, via:string}|null,
 *          version?:string, error?:string},
 *   webParser?: {path?:string, ok?:boolean, error?:string},
 *   drivers?: {dialect:string, module:string, pip:string, ok:boolean, version?:string, error?:string}[],
 *   docker?: {ok?:boolean, version?:string, error?:string},
 *   registry?: {path?:string, exists?:boolean, ok?:boolean, projects?:number, error?:string},
 *   cache?: {path?:string, ok?:boolean, error?:string},
 * }} probes
 * @returns {{schema:string, checks:object[], ok:boolean, counts:{ok:number,warn:number,missing:number}}}
 */
export function buildDoctorReport(probes = {}) {
  const checks = [];

  // ---- Node ---------------------------------------------------------------
  const nodeVersion = probes.node?.version ?? null;
  const nodeMajor = majorOf(nodeVersion);
  checks.push(check(
    'node', `node >= ${MIN_NODE_MAJOR}`, true,
    nodeMajor == null ? 'missing' : (nodeMajor >= MIN_NODE_MAJOR ? 'ok' : 'missing'),
    nodeVersion ?? 'no version reported',
    nodeMajor != null && nodeMajor >= MIN_NODE_MAJOR ? null
      : `install Node ${MIN_NODE_MAJOR} or newer (package.json engines.node)`,
  ));

  // ---- git ----------------------------------------------------------------
  // Required, not optional: the analysed unit is a COMMIT (SPEC §2.1), the
  // incremental plan is a `git diff`, and the overlay is the working-tree
  // difference from a commit. Without git the engine can still parse, but every
  // one of those becomes "unknown", which is a different product.
  checks.push(check(
    'git', 'git', true,
    probes.git?.ok ? 'ok' : 'missing',
    probes.git?.ok ? (probes.git.version ?? 'present') : (probes.git?.error ?? 'not found on PATH'),
    probes.git?.ok ? null : 'install git. The pack pins a commit, and both the incremental plan and the overlay are git diffs',
  ));

  // ---- python venv --------------------------------------------------------
  const pyPath = probes.python?.path ?? '<engine>/.venv/bin/python';
  checks.push(check(
    'python-venv', 'python venv (SQL lane)', true,
    probes.python?.ok ? 'ok' : 'missing',
    probes.python?.ok ? `${pyPath}: ${probes.python.version ?? 'version not reported'}`
      : (probes.python?.error ?? `no interpreter at ${pyPath}`),
    probes.python?.ok ? null : 'python3 -m venv .venv && .venv/bin/pip install -r adapters/sql/requirements.txt (docs/setup/sql-lane.md)',
  ));

  // ---- sqlglot ------------------------------------------------------------
  checks.push(check(
    'sqlglot', 'sqlglot importable (SQL lane)', true,
    probes.sqlglot?.ok ? 'ok' : 'missing',
    probes.sqlglot?.ok ? `sqlglot ${probes.sqlglot.version ?? '(version not reported)'}`
      : (probes.sqlglot?.error ?? 'import failed'),
    probes.sqlglot?.ok ? null : '.venv/bin/pip install -r adapters/sql/requirements.txt (docs/setup/sql-lane.md)',
  ));

  // ---- JDK ----------------------------------------------------------------
  // The detail is the WHOLE search, not just its verdict: on a machine with
  // three half-JDKs, "no JDK found" is useless and "JAVA_HOME/bin has java but
  // no javac; the homebrew keg has both" is actionable.
  const cands = probes.jdk?.candidates ?? [];
  const trail = cands.map((c) => {
    if (c.javac && c.java) return `${c.dir} (${c.via}): javac+java`;
    if (c.javac) return `${c.dir} (${c.via}): javac only, no java`;
    if (c.java) return `${c.dir} (${c.via}): java only, no javac (a JRE, not a JDK)`;
    return `${c.dir} (${c.via}): absent`;
  });
  const chosen = probes.jdk?.chosen ?? null;
  checks.push(check(
    'jdk', 'JDK 17+ (java lane)', true,
    chosen ? 'ok' : 'missing',
    chosen
      ? `${chosen.javac} via ${chosen.via}${probes.jdk?.version ? `: ${probes.jdk.version}` : ''}`
        + (trail.length ? `; searched: ${trail.join('; ')}` : '')
      : (trail.length ? `no javac+java pair found; searched: ${trail.join('; ')}`
        : (probes.jdk?.error ?? 'no JDK found')),
    chosen ? null : 'install a JDK 17+ and set JAVA_HOME, or put javac on PATH (docs/setup/java-lane.md)',
  ));

  // ---- the web lane's parser ---------------------------------------------
  // Required, and cheap to check: the parser is VENDORED (adapters/web/vendor),
  // so there is nothing to install and the only way this fails is a truncated
  // checkout or a file somebody edited. It is checked by PARSING, not by
  // stat-ing the file, because a bundle that loads and cannot parse is the
  // failure that would otherwise surface as "0 frontend calls".
  checks.push(check(
    'web-parser', 'web lane parser (vendored)', true,
    probes.webParser?.ok ? 'ok' : 'missing',
    probes.webParser?.ok
      ? `${probes.webParser.path ?? 'adapters/web/vendor/babel-parser.cjs'} loads and parses`
      : (probes.webParser?.error ?? 'the vendored parser could not be loaded'),
    probes.webParser?.ok ? null
      : 're-checkout adapters/web/vendor/babel-parser.cjs (it is vendored, not installed; see adapters/web/vendor/README.md)',
  ));

  // ---- optional DB drivers (SPEC §12; RM6) --------------------------------
  // OPTIONAL on purpose: the extraction path never connects to a database
  // (§2.3), so a missing driver costs you `cascade catalog fetch` and nothing
  // else. Reported anyway, because "which dialect can I fetch today" is a
  // question the error message alone answers too late.
  for (const d of probes.drivers ?? []) {
    checks.push(check(
      `driver-${d.dialect}`, `${d.dialect} driver (optional, catalog fetch)`, false,
      d.ok ? 'ok' : 'missing',
      d.ok ? `${d.module} ${d.version ?? '(version not reported)'}` : (d.error ?? `${d.module} is not installed`),
      d.ok ? null : `.venv/bin/pip install ${d.pip}. This is only needed for \`cascade catalog fetch\` against ${d.dialect}`,
    ));
  }

  // ---- Docker (optional; the live-catalog container test) -----------------
  checks.push(check(
    'docker', 'docker (optional, live-catalog container test)', false,
    probes.docker?.ok ? 'ok' : 'missing',
    probes.docker?.ok ? (probes.docker.version ?? 'daemon reachable') : (probes.docker?.error ?? 'no reachable docker daemon'),
    probes.docker?.ok ? null : 'install/start Docker to run adapters/sql/test_catalog_live_container.py locally; CI runs it without you',
  ));

  // ---- the registry -------------------------------------------------------
  // A registry that does not exist yet is NOT a fault: `cascade init` writes it.
  // One that exists and cannot be parsed IS, because every `--project` lookup
  // goes through it.
  const regPath = probes.registry?.path ?? '~/.cascade/registry.json';
  let regStatus = 'ok';
  let regDetail;
  if (probes.registry?.exists === false) {
    regStatus = 'ok';
    regDetail = `${regPath} does not exist yet. \`cascade init\` writes it (no project is registered)`;
  } else if (probes.registry?.ok) {
    regDetail = `${regPath}: ${probes.registry.projects ?? 0} project(s)`;
  } else {
    regStatus = 'warn';
    regDetail = `${regPath} is unreadable: ${probes.registry?.error ?? 'unknown error'}`;
  }
  checks.push(check(
    'registry', 'project registry readable', false, regStatus, regDetail,
    regStatus === 'warn' ? `fix or delete ${regPath}; \`cascade init\` will write a fresh one` : null,
  ));

  // ---- the XDG cache directory -------------------------------------------
  // Required: the content-addressed fact shards live here (SPEC §5.1), and an
  // unwritable cache turns every run cold without saying why.
  checks.push(check(
    'cache-dir', 'cache directory writable', true,
    probes.cache?.ok ? 'ok' : 'missing',
    probes.cache?.ok ? (probes.cache.path ?? 'writable')
      : `${probes.cache?.path ?? '$XDG_CACHE_HOME/cascade'}: ${probes.cache?.error ?? 'not writable'}`,
    probes.cache?.ok ? null : 'make the directory writable, or point $XDG_CACHE_HOME somewhere you own. Without it every run is cold',
  ));

  const counts = { ok: 0, warn: 0, missing: 0 };
  for (const c of checks) counts[c.status] += 1;
  const ok = checks.every((c) => !c.required || c.status === 'ok');
  return { schema: DOCTOR_SCHEMA, checks, ok, counts };
}

/**
 * The report as one fixed-width table. Returned as a string (not printed), so
 * the exact bytes can be asserted.
 * @param {{checks:object[], ok:boolean, counts:object}} report
 * @returns {string}
 */
export function formatDoctorTable(report) {
  const rows = report.checks;
  const w = (key, min) => Math.max(min, ...rows.map((r) => String(r[key]).length));
  const labelW = w('label', 5);
  const lines = [];
  for (const r of rows) {
    lines.push(`${r.status.padEnd(7)} ${r.label.padEnd(labelW)}  ${r.detail}`);
    if (r.remedy) lines.push(`${''.padEnd(7)} ${''.padEnd(labelW)}  -> ${r.remedy}`);
  }
  const required = rows.filter((r) => r.required);
  const bad = required.filter((r) => r.status !== 'ok');
  lines.push('');
  lines.push(bad.length === 0
    ? `all ${required.length} required prerequisite(s) ok (${report.counts.ok} ok, ${report.counts.warn} warn, ${report.counts.missing} missing)`
    : `${bad.length} required prerequisite(s) not satisfied: ${bad.map((r) => r.id).join(', ')}`);
  return lines.join('\n') + '\n';
}
