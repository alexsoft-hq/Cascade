// catalog.mjs — `cascade catalog`: the DB catalog adapter (SPEC §12).
//
// THREE subcommands, and the split is the whole security design (§12.3, §17.5):
//
//   discover     reads the repository and LISTS where a database might be. It
//                connects to nothing and it never reads a password value.
//   fetch        connects — once, read-only, and ONLY after the user has seen
//                the exact target and confirmed it. The connection info comes
//                out of the analyzed repository, which is untrusted input: a
//                malicious checkout must not be able to make this tool dial a
//                host of the attacker's choosing.
//   credentials  manages the ONE file that holds a password, in the tool home
//                at mode 0600, never under a project tree.
//
// Nothing writes a credential into the project (§17.3). The password is never
// an argument; the worker reads it from the environment variable named by
// --password-env, and it never reaches `.cascade/`, the pack, or a log.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  credentialsPath, serverKey, findPassword, listCredentials,
  setCredential, removeCredential, modeVerdict, isInside, CredentialsError,
} from '../../core/credentials.mjs';
import { describeCandidate, parseConnectionUrl, DEFAULT_PORTS, CONNECTION_DIALECTS } from '../../core/dbconfig.mjs';
import { discover } from '../../core/discover.mjs';
import { writeStateFile } from '../../core/init.mjs';
import { ensureProjectDirs } from '../../core/paths.mjs';
import { normalizeProfile, validateProfile } from '../../core/profile.mjs';
import { resolveProject } from '../../core/resolve.mjs';
import {
  DEFAULT_PASSWORD_ENV, DISCOVER_IO, ENGINE_ROOT, catalogPathsOf, jsonl, noSqlPython, realPath, sqlPython,
} from '../env.mjs';
import { sha256File } from '../state.mjs';
import { confirmYesNo, promptHidden } from '../tty.mjs';

/**
 * The credentials file for this run, refusing the one place it must never be.
 * `CASCADE_HOME` is an override for tests and for a reader who keeps tool
 * state elsewhere; pointed inside an analyzed project it would put the
 * password in the tree, and a tree travels.
 */
function credentialsFileOrDie({ opt, die }) {
  const file = credentialsPath(process.env);
  let projectRoot = null;
  try {
    const r = resolveProject({ project: opt('project'), root: opt('root'), cwd: process.cwd(), env: process.env });
    if (r.dotCascade && fs.existsSync(r.dotCascade)) projectRoot = path.dirname(r.dotCascade);
  } catch { projectRoot = null; }
  if (projectRoot && isInside(file, projectRoot)) {
    die(`the credentials file would be ${file}, which is inside the project at ${projectRoot}.\n`
      + '  A password under an analyzed tree travels with the tree. A zip, a copy to a colleague, a `git add -f`,\n'
      + '  a cloud-drive sync and a container mount all carry it along, and a gitignore stops none of them.\n'
      + '  Point CASCADE_HOME somewhere outside the project (the default, ~/.cascade, already is).');
  }
  return file;
}

/**
 * The connection target the flags name: a URL, or the fields spelled out. The
 * SAME parse `fetch` uses, so a target that works there works here, and a
 * password smuggled into a URL is stripped rather than used.
 */
function targetFromFlags({ opt, die }) {
  let t;
  if (opt('url')) {
    const parsed = parseConnectionUrl(opt('url'));
    if (!parsed) die(`--url ${JSON.stringify(opt('url'))} is not a connection URL (jdbc:mysql://…, jdbc:postgresql://…, jdbc:oracle:thin:@…, postgres://…, mysql://…)`);
    for (const note of parsed.notes) process.stderr.write(`note: ${note}\n`);
    t = {
      dialect: opt('dialect', parsed.dialect), host: opt('host', parsed.host),
      port: opt('port') ? Number(opt('port')) : parsed.port,
      database: opt('database', parsed.database),
      user: opt('user', parsed.usernameRef && !/^\$\{/.test(parsed.usernameRef) ? parsed.usernameRef : null),
    };
  } else {
    t = {
      dialect: opt('dialect'), host: opt('host'),
      port: opt('port') ? Number(opt('port')) : null,
      database: opt('database'), user: opt('user'),
    };
  }
  if (t.dialect && !t.port) t.port = DEFAULT_PORTS[t.dialect] ?? null;
  const missing = ['dialect', 'host', 'port', 'database', 'user'].filter((k) => !t[k]);
  if (missing.length > 0) {
    die(`the connection target is incomplete (missing: ${missing.join(', ')}).\n`
      + '  Name it as a URL, or field by field:\n'
      + '  --url jdbc:mysql://host:3306/db --user u\n'
      + '  --dialect mysql --host host --port 3306 --database db --user u');
  }
  if (!CONNECTION_DIALECTS.includes(t.dialect)) {
    die(`--dialect ${t.dialect} is not one of ${CONNECTION_DIALECTS.join('|')}`);
  }
  return t;
}

// ---- discover ---------------------------------------------------------------

function runDiscover({ opt, flag, die }) {
  const asJson = flag('json');
  const root = realPath(path.resolve(opt('root', process.cwd())));
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) die(`--root ${root} is not a directory`);
  const discovery = discover(root, DISCOVER_IO);
  const candidates = discovery.connectionCandidates ?? [];
  if (asJson) {
    process.stdout.write(JSON.stringify({
      schema: 'cascade:catalog-candidates:1', root, candidates,
    }, null, 2) + '\n');
    process.exit(0);
  }
  process.stdout.write(`connection-info candidates under ${root}: ${candidates.length}\n`);
  if (candidates.length === 0) {
    process.stdout.write('  none: no application.yml / .properties / .env in this tree names a datasource URL.\n'
      + '  A DDL file works just as well, and needs no connection at all: `cascade analyze --ddl <schema.sql>`.\n');
  }
  candidates.forEach((c, i) => {
    process.stdout.write(`  [${i + 1}] ${c.path}  (${c.kind})\n`
      + `      ${describeCandidate(c)}\n`
      + `      ${c.url}\n`);
  });
  if (candidates.length > 0) {
    process.stdout.write('\nNo password VALUE is read, printed or stored, only whether one is there and where it comes from.\n'
      + 'Nothing above has been connected to. To pin a read-only snapshot of one of them:\n'
      + '  cascade catalog fetch --candidate 1\n'
      + 'It shows the target and asks before it connects, and asks for the password without echoing it.\n'
      + `In a script there is nobody to ask, so pass --yes and put the password in ${DEFAULT_PASSWORD_ENV}.\n`);
  }
  process.exit(0);
}

// ---- credentials ------------------------------------------------------------
//
// WHY A FILE IN THE HOME AND NOT IN THE PROJECT. A gitignore is a convention,
// not a boundary: a project directory gets force-added, zipped, copied to a
// colleague, synced to a cloud drive and mounted into a container, and every
// one of those carries whatever is inside it along. So the password lives in
// the tool home at mode 0600, keyed by server and user, exactly the way
// ~/.pgpass and ~/.my.cnf have worked for decades. src/core/credentials.mjs
// holds the format and the permission rule; this block is the command.

function credentialsList({ die }, file) {
  let held;
  try { held = listCredentials(file); }
  catch (e) { die(e instanceof CredentialsError ? e.message : `cannot read ${file}: ${e.message}`); }
  if (!modeVerdict(file).exists) {
    process.stdout.write(`no credentials file at ${file} yet.\n`
      + '  `cascade catalog credentials set --url <jdbc url> --user <u>` creates one, at mode 0600.\n');
    process.exit(0);
  }
  process.stdout.write(`credentials in ${file} (${held.length}):\n`);
  for (const e of held) process.stdout.write(`  ${e.server}  as user ${e.user}\n`);
  process.stdout.write('no password is printed here, and none ever will be. This is the whole list of what is stored:\n'
    + 'a server, a user, and a secret only the fetch reads.\n');
  process.exit(0);
}

function credentialsRemove({ die }, file, server, t) {
  let result;
  try { result = removeCredential(file, server, t.user); }
  catch (e) { die(e instanceof CredentialsError ? e.message : `cannot rewrite ${file}: ${e.message}`); }
  if (!result.removed) die(`no entry for ${server} as user ${t.user} in ${file}. \`cascade catalog credentials list\` shows what is there`);
  process.stderr.write(`removed ${server} as user ${t.user} from ${file} (${result.remaining} entry(ies) left)\n`);
  process.exit(0);
}

// The password itself never arrives as an argument, so it comes from the
// environment (scriptable) or from a hidden prompt (interactive).
function credentialsSet({ opt, die }, file, server, t) {
  const setEnv = opt('password-env');
  let secret = null;
  if (setEnv) {
    secret = process.env[setEnv];
    if (!secret) die(`the environment variable ${setEnv} is empty. Put the password there (\`export ${setEnv}='…'\`) or drop --password-env and be asked for it`);
  } else if (process.env[DEFAULT_PASSWORD_ENV]) {
    secret = process.env[DEFAULT_PASSWORD_ENV];
  } else if (process.stdin.isTTY) {
    secret = promptHidden(`password for ${server} as user ${t.user} (not echoed): `);
    if (!secret) die('nothing was typed, so nothing was stored');
  } else {
    die(`there is no password to store and no terminal to ask on.\n`
      + `  Set ${DEFAULT_PASSWORD_ENV}, or name another variable with --password-env <NAME>,\n`
      + '  or run this command in a terminal and be asked for it.');
  }
  let result;
  try { result = setCredential(file, { server, user: t.user, password: secret }); }
  catch (e) { die(e instanceof CredentialsError ? e.message : `cannot write ${file}: ${e.message}`); }
  process.stderr.write(`${result.replaced ? 'replaced' : 'stored'} the password for ${server} as user ${t.user} in ${file} (mode 0600)\n`
    + '  It is outside every project tree on purpose, so no copy, zip or push of a repository carries it.\n');
  process.exit(0);
}

function runCredentials(ctx) {
  const { argv, die } = ctx;
  const op = argv[2];
  if (!['list', 'set', 'remove'].includes(op ?? '')) {
    die('usage: cascade catalog credentials list\n'
      + '       cascade catalog credentials set    --url <jdbc url> --user <u> [--password-env NAME]\n'
      + '       cascade catalog credentials remove --url <jdbc url> --user <u>\n'
      + '       (--dialect <d> --host <h> [--port <p>] --database <db> --user <u> names the same target field by field)');
  }
  const file = credentialsFileOrDie(ctx);
  if (op === 'list') credentialsList(ctx, file);
  const t = targetFromFlags(ctx);
  const server = serverKey(t);
  if (op === 'remove') credentialsRemove(ctx, file, server, t);
  credentialsSet(ctx, file, server, t);
}

// ---- fetch ------------------------------------------------------------------

/**
 * Where the target comes from: a discovered candidate, or flags the user typed.
 * `--url` is parsed by the SAME code `discover` reads a config file with, so a
 * URL that works there works here — and a password smuggled into it is stripped
 * out rather than used, because the password comes from the environment, always.
 */
function fetchTarget({ opt, die }, root) {
  const candidateOpt = opt('candidate');
  let target;
  let candidatePath = null;
  if (candidateOpt !== undefined) {
    const discovery = discover(root, DISCOVER_IO);
    const candidates = discovery.connectionCandidates ?? [];
    const n = Number(candidateOpt);
    if (!Number.isInteger(n) || n < 1 || n > candidates.length) {
      die(`--candidate ${JSON.stringify(candidateOpt)} is not one of the ${candidates.length} candidate(s) under ${root}. Run \`cascade catalog discover\` to see them`);
    }
    const c = candidates[n - 1];
    candidatePath = c.path;
    target = {
      dialect: c.dialect, host: c.host, port: c.port ?? (c.dialect ? DEFAULT_PORTS[c.dialect] : null),
      database: c.database, user: opt('user', c.usernameRef ?? null),
    };
    if (target.user && /^\$\{/.test(target.user)) {
      die(`candidate ${n} names its user as the unresolved placeholder ${target.user}. Pass --user <name> explicitly`);
    }
  } else if (opt('url')) {
    const parsed = parseConnectionUrl(opt('url'));
    if (!parsed) die(`--url ${JSON.stringify(opt('url'))} is not a connection URL (jdbc:mysql://…, jdbc:postgresql://…, jdbc:oracle:thin:@…, postgres://…, mysql://…)`);
    for (const note of parsed.notes) process.stderr.write(`note: ${note}\n`);
    target = {
      dialect: opt('dialect', parsed.dialect), host: opt('host', parsed.host),
      port: opt('port') ? Number(opt('port')) : parsed.port,
      database: opt('database', parsed.database),
      user: opt('user', parsed.usernameRef && !/^\$\{/.test(parsed.usernameRef) ? parsed.usernameRef : null),
    };
    if (target.dialect && !target.port) target.port = DEFAULT_PORTS[target.dialect] ?? null;
  } else {
    target = {
      dialect: opt('dialect'), host: opt('host'),
      port: opt('port') ? Number(opt('port')) : null,
      database: opt('database'), user: opt('user'),
    };
    if (target.dialect && !target.port) target.port = DEFAULT_PORTS[target.dialect] ?? null;
  }
  const missing = ['dialect', 'host', 'port', 'database', 'user'].filter((k) => !target[k]);
  if (missing.length > 0) {
    die(`the connection target is incomplete (missing: ${missing.join(', ')}).\n`
      + '  Pass --candidate <n> (see `cascade catalog discover`), or --url with --user, or spell it out:\n'
      + '  cascade catalog fetch --url jdbc:mysql://h:3306/db --user u --password-env VAR --yes\n'
      + '  cascade catalog fetch --dialect mysql --host h --port 3306 --database db --user u --password-env VAR --yes');
  }
  if (!CONNECTION_DIALECTS.includes(target.dialect)) {
    die(`--dialect ${target.dialect} is not one of ${CONNECTION_DIALECTS.join('|')}`);
  }
  return { target, candidatePath };
}

/**
 * WHERE THE PASSWORD WILL COME FROM, decided before anything is printed and
 * long before anything is typed, so the confirmation below can say it. The
 * order is the order of decreasing explicitness:
 *
 *   1. --password-env NAME     the reader named the variable on this command
 *   2. CASCADE_DB_PASSWORD     the variable this tool has always read
 *   3. the credentials file    $CASCADE_HOME/credentials, mode 0600, keyed by
 *                              server and user
 *   4. a hidden prompt         only with a terminal to ask on, and it offers
 *                              to save what it was told
 *
 * The VALUE is not fetched yet for 3 and 4: the plan is, the secret is read
 * after the target is confirmed. Nothing is read out of the analyzed
 * repository, ever, whatever password that file carries.
 */
function passwordPlan({ die }, { credFile, server, target, passwordEnvOpt, passwordEnv }) {
  let credentialsHolds = false;
  if (!passwordEnvOpt && !process.env[DEFAULT_PASSWORD_ENV]) {
    try { credentialsHolds = findPassword(credFile, server, target.user) !== null; }
    catch (e) { die(e instanceof CredentialsError ? e.message : `cannot read ${credFile}: ${e.message}`); }
  }
  const passwordFrom = passwordEnvOpt ? 'env-named'
    : process.env[DEFAULT_PASSWORD_ENV] ? 'env-default'
      : credentialsHolds ? 'credentials'
        : process.stdin.isTTY ? 'prompt' : 'nowhere';
  const passwordSourceLine = {
    'env-named': `from the environment variable ${passwordEnv} (never from the command line, never stored)`,
    'env-default': `from the environment variable ${DEFAULT_PASSWORD_ENV} (never from the command line, never stored)`,
    credentials: `from ${credFile} (mode 0600, this server and this user)`,
    prompt: 'asked for here, not echoed, and stored only if you say so',
    nowhere: 'NOT AVAILABLE YET, see below',
  }[passwordFrom];
  return { passwordFrom, passwordSourceLine };
}

/**
 * THE CONFIRMATION (SPEC §12.3, §17.5). What is about to happen, in full,
 * before it happens. In a terminal the reader answers it here; outside one,
 * --yes is the answer, because a script cannot be asked.
 */
function confirmTarget({ flag }, { target, identity, passwordSourceLine, candidatePath, dotCascade }) {
  process.stderr.write(
    'cascade catalog fetch would open a READ-ONLY connection to:\n'
    + `  ${target.dialect} ${identity}\n`
    + `  as user      ${target.user}\n`
    + `  password     ${passwordSourceLine}\n`
    + `  read from    ${candidatePath ?? 'flags you typed'}\n`
    + `  writes       ${catalogPathsOf(dotCascade).catalog}\n`
    + `               ${catalogPathsOf(dotCascade).catalogSnapshot}\n`
    + '  queries      metadata SELECTs only (tables, columns, comments, primary keys)\n');
  if (flag('yes')) return;
  if (process.stdin.isTTY) {
    // The same one-glance confirmation, asked instead of demanded. It stays
    // because the host above came out of the analyzed repository, and a
    // saved credential for that host does not make the host trustworthy.
    if (!confirmYesNo('\nConnect to this target? [y/N] ')) {
      process.stderr.write('nothing was connected to.\n');
      process.exit(2);
    }
    return;
  }
  process.stderr.write(
    '\nRefusing to connect: pass --yes to confirm this exact target.\n'
    + '  The connection info above came out of the analyzed repository, which this tool treats as\n'
    + '  untrusted input. A checkout must not be able to make it dial a host by itself.\n');
  process.exit(2);
}

/** NOW the secret, and only now — after the target above has been confirmed. */
function readPassword({ die }, { passwordFrom, passwordEnv, credFile, server, target, identity }) {
  let password = null;
  let offerToSave = false;
  if (passwordFrom === 'env-named') {
    password = process.env[passwordEnv];
    if (!password) die(`the environment variable ${passwordEnv} is empty. Put the password there (\`export ${passwordEnv}='…'\`) or name another one with --password-env`);
  } else if (passwordFrom === 'env-default') {
    password = process.env[DEFAULT_PASSWORD_ENV];
  } else if (passwordFrom === 'credentials') {
    try { password = findPassword(credFile, server, target.user); }
    catch (e) { die(e instanceof CredentialsError ? e.message : `cannot read ${credFile}: ${e.message}`); }
    if (!password) die(`${credFile} no longer holds an entry for ${server} as user ${target.user}`);
  } else if (passwordFrom === 'prompt') {
    password = promptHidden(`password for ${target.user} at ${identity} (not echoed): `);
    if (!password) die('nothing was typed, so nothing was connected to');
    offerToSave = true;
  } else {
    die('there is no password for this connection, and no terminal to ask on. In order, this command reads:\n'
      + '  1. the variable named by --password-env <NAME>\n'
      + `  2. the environment variable ${DEFAULT_PASSWORD_ENV}\n`
      + `  3. an entry in ${credFile} for ${server} as user ${target.user}\n`
      + '     (`cascade catalog credentials set --url <jdbc url> --user <u>` writes one, at mode 0600)\n'
      + '  4. a hidden prompt, when a terminal is attached\n'
      + '  This run has none of the four.');
  }
  if (offerToSave && confirmYesNo(`Save it in ${credFile} for next time? [y/N] `)) {
    try {
      setCredential(credFile, { server, user: target.user, password });
      process.stderr.write(`saved ${server} as user ${target.user} in ${credFile} (mode 0600, outside every project tree)\n`);
    } catch (e) {
      process.stderr.write(`could not save it: ${e.message}\n  The fetch below runs anyway.\n`);
    }
  }
  return password;
}

/**
 * Run the live-catalog worker into a partial file and hand back its records.
 *
 * The worker takes the password from an environment variable it is told the
 * NAME of, so a password that came from the file or the prompt travels the same
 * way: into the CHILD's environment only, under the default name, never into
 * this process's own and never into argv.
 */
function runCatalogWorker({ opt, die }, { target, identity, partial, password, passwordFrom, passwordEnv }) {
  const workerEnv = { ...process.env };
  const workerPasswordEnv = passwordFrom === 'env-named' ? passwordEnv : DEFAULT_PASSWORD_ENV;
  workerEnv[workerPasswordEnv] = password;

  const workerArgs = [
    '--dialect', target.dialect, '--host', target.host, '--port', String(target.port),
    '--database', target.database, '--user', target.user,
    '--password-env', workerPasswordEnv, '--out', partial,
  ];
  if (opt('schema')) workerArgs.push('--schema', opt('schema'));
  if (opt('stamp-schema')) workerArgs.push('--stamp-schema', opt('stamp-schema'));

  // The worker is overridable so the credential-non-leak test can run the whole
  // path end to end without a database (test/catalog_fetch.test.mjs).
  const override = process.env.CASCADE_CATALOG_WORKER;
  let cmdPath;
  let cmdArgs;
  if (override) {
    const isNodeScript = /\.(mjs|cjs|js)$/.test(override);
    cmdPath = isNodeScript ? process.execPath : override;
    cmdArgs = isNodeScript ? [override, ...workerArgs] : workerArgs;
  } else {
    const pyRes = sqlPython();
    if (!pyRes.ok) die(noSqlPython('reading a live catalog', pyRes));
    cmdPath = pyRes.path;
    cmdArgs = [path.join(ENGINE_ROOT, 'adapters', 'sql', 'catalog_live.py'), ...workerArgs];
  }

  process.stderr.write(`connecting (read-only) to ${target.dialect} ${identity}…\n`);
  try {
    execFileSync(cmdPath, cmdArgs, { stdio: ['ignore', 'inherit', 'inherit'], env: workerEnv, maxBuffer: 1 << 28 });
  } catch (e) {
    try { fs.unlinkSync(partial); } catch { /* nothing to clean up */ }
    die(`the catalog worker failed (exit ${e.status ?? '?'}). Nothing was written.\n`
      + '  A missing driver, a refused login and an unreachable host are all reported above as a structured line.');
  }

  let records;
  try { records = jsonl(partial); }
  catch (e) { die(`the catalog worker produced no readable JSONL at ${partial}: ${e.message}`); }
  const header = records[0];
  if (!header || header.kind !== 'header' || header.schema !== 'cascade:catalog-snapshot:1') {
    try { fs.unlinkSync(partial); } catch { /* best effort */ }
    die(`the catalog worker's first record is not a cascade:catalog-snapshot:1 header. Refusing to pin it`);
  }
  return { records, header };
}

/** Publish the partial file as the snapshot, with the provenance beside it. */
function pinSnapshot({ paths, partial, records, header, target, identity, candidatePath }) {
  const tables = records.filter((r) => r.kind === 'table').length;
  const columns = records.filter((r) => r.kind === 'column').length;
  const commented = records.filter((r) => r.kind === 'column' && r.comment != null).length;

  fs.renameSync(partial, paths.catalog);
  const sha256 = sha256File(paths.catalog);
  const provenance = {
    schema: 'cascade:catalog-provenance:1',
    dialect: header.dialect ?? target.dialect,
    serverVersion: header.serverVersion ?? null,
    // host:port/db. No user, no password — a provenance record is a fact about
    // the SCHEMA, not a way back into the database (§17.3).
    serverIdentity: header.serverIdentity ?? identity,
    fetchedAt: header.fetchedAt ?? null,
    sha256,
    file: path.basename(paths.catalog),
    candidate: candidatePath,
    worker: header.version ?? null,
    rowCounts: { tables, columns, commented },
  };
  fs.writeFileSync(paths.catalogSnapshot, JSON.stringify(provenance, null, 2) + '\n', 'utf8');
  return { provenance, sha256, tables, columns, commented };
}

/**
 * THE PROFILE, FINISHED. A snapshot nothing reads is not a schema, and asking
 * the reader to hand-edit a JSON key to make the fetch they just confirmed
 * count was a step that only ever produced an empty ERD and a puzzled reader.
 * The write is narrow: `catalog.source` and, when a candidate chose it,
 * `catalog.connectionFrom`. Every other key is left exactly as it was.
 */
function updateProfileCatalog(profileFile, candidatePath) {
  try {
    const existing = JSON.parse(fs.readFileSync(profileFile, 'utf8'));
    const before = { ...(existing.catalog ?? {}) };
    existing.catalog = {
      ...before,
      source: 'jdbc',
      ...(candidatePath ? { connectionFrom: candidatePath } : {}),
    };
    validateProfile(normalizeProfile(existing));
    writeStateFile(profileFile, existing);
    return `wrote "catalog": { "source": "jdbc"${candidatePath ? `, "connectionFrom": "${candidatePath}"` : ''} } into ${profileFile}\n`
      + `  (it was "${before.source ?? 'none'}"). The next \`cascade analyze\` reads the snapshot above.\n`;
  } catch (e) {
    return `could NOT update ${profileFile} (${e.message}).\n`
      + '  The snapshot is pinned. To analyze against it, set there by hand:\n'
      + '  "catalog": { "source": "jdbc" }\n';
  }
}

function runFetch(ctx) {
  const { opt, flag, die, resolveOrDie } = ctx;
  const asJson = flag('json');
  const root = realPath(path.resolve(opt('root', process.cwd())));
  const resolved = resolveOrDie({ strictProject: false });
  if (!resolved.dotCascade) {
    die('no project state directory (.cascade/) for this target. Run `cascade init` first, so the snapshot has a home that is already gitignored');
  }
  const passwordEnvOpt = opt('password-env');
  const passwordEnv = passwordEnvOpt ?? DEFAULT_PASSWORD_ENV;

  const { target, candidatePath } = fetchTarget(ctx, root);
  const credFile = credentialsFileOrDie(ctx);
  const identity = `${target.host}:${target.port}/${target.database}`;
  const server = serverKey(target);
  const { passwordFrom, passwordSourceLine } = passwordPlan(ctx, { credFile, server, target, passwordEnvOpt, passwordEnv });

  confirmTarget(ctx, { target, identity, passwordSourceLine, candidatePath, dotCascade: resolved.dotCascade });
  const password = readPassword(ctx, { passwordFrom, passwordEnv, credFile, server, target, identity });

  const paths = ensureProjectDirs(path.dirname(resolved.dotCascade));
  const partial = path.join(path.dirname(paths.catalog), '.columns.jsonl.partial');
  const { records, header } = runCatalogWorker(ctx, { target, identity, partial, password, passwordFrom, passwordEnv });
  const pinned = pinSnapshot({ paths, partial, records, header, target, identity, candidatePath });
  const profileNote = updateProfileCatalog(path.join(resolved.dotCascade, 'profile.json'), candidatePath);

  process.stderr.write(
    `wrote ${paths.catalog}: ${pinned.tables} table(s), ${pinned.columns} column(s), ${pinned.commented} with a comment\n`
    + `wrote ${paths.catalogSnapshot}: sha256 ${pinned.sha256.slice(0, 12)}…, fetched ${pinned.provenance.fetchedAt}\n`
    + 'both are inside the gitignored catalog/ directory, and no password was written to either.\n'
    + profileNote);
  if (asJson) process.stdout.write(JSON.stringify(pinned.provenance, null, 2) + '\n');
  process.exit(0);
}

export function run(ctx) {
  const { argv, die } = ctx;
  const sub = argv[1];
  if (sub === 'discover') runDiscover(ctx);
  if (sub === 'credentials') runCredentials(ctx);
  if (sub !== 'fetch') {
    die('usage: cascade catalog discover [--root <dir>] [--json]\n'
      + '       cascade catalog fetch [--project <id>|--root <dir>]\n'
      + '                             [--candidate <n> | --url <jdbc url> --user <u>\n'
      + '                              | --dialect <d> --host <h> [--port <p>] --database <db> --user <u>]\n'
      + '                             [--password-env NAME] [--schema NAME] [--stamp-schema NAME] [--yes]\n'
      + '       cascade catalog credentials <list|set|remove> [--url <jdbc url> --user <u>]');
  }
  runFetch(ctx);
}
