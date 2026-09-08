import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// `cascade catalog` as a USER meets it (SPEC §12, §15 M5):
//
//   discover  lists where a database might be, REDACTED, connecting to nothing;
//   fetch     refuses to connect until the user has seen the exact target and
//             said --yes, then pins a snapshot with provenance;
//   analyze   reads that snapshot and never opens a connection of its own.
//
// The fetch tests run against a STUB worker (CASCADE_CATALOG_WORKER), so the
// whole path — argv, environment, snapshot, provenance, profile advice — is
// exercised end to end with no database and no driver. The stub asserts the
// password reached it through the ENVIRONMENT, which is what makes the leak
// test below meaningful: the secret really did travel, and still shows up
// nowhere on disk (SPEC §17.3).

const ENGINE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const CLI = path.join(ENGINE_ROOT, 'bin', 'cascade.mjs');

const SECRET = 'pw-SECRET-123';
const PASSWORD_ENV = 'CASCADE_TEST_DB_PASSWORD';

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'cat', GIT_AUTHOR_EMAIL: 'cat@example.com',
  GIT_COMMITTER_NAME: 'cat', GIT_COMMITTER_EMAIL: 'cat@example.com',
};

const YML = `spring:
  application:
    name: shop
  datasource:
    url: jdbc:mysql://db.example.com:3306/shop?useUnicode=true
    username: shop_app
    password: ${SECRET}
`;

const MAPPER = `<?xml version="1.0" encoding="UTF-8"?>
<mapper namespace="com.example.mapper.OrderMapper">
  <select id="selectById" resultType="java.util.Map">
    select id, order_sn from shop_order where id = #{id}
  </select>
</mapper>
`;

// What the stub worker writes: a valid cascade:catalog-snapshot:1 stream.
const SNAPSHOT_RECORDS = [
  {
    kind: 'header', schema: 'cascade:catalog-snapshot:1', version: 'catalog-live/1',
    source: 'jdbc', dialect: 'mysql', serverVersion: '8.0.36',
    serverIdentity: 'db.example.com:3306/shop', fetchedAt: '2026-01-02T03:04:05Z',
    rowCounts: { tables: 1, columns: 2, commented: 1 },
  },
  { kind: 'table', schema: null, table: 'shop_order', comment: 'Customer order header' },
  { kind: 'column', schema: null, table: 'shop_order', column: 'id', type: 'BIGINT', nullable: false, comment: null, ordinal: 1, pk: true },
  { kind: 'column', schema: null, table: 'shop_order', column: 'order_sn', type: 'VARCHAR(64)', nullable: false, comment: 'Order code', ordinal: 2, pk: false },
];

// The stub. It proves the password arrived through the ENVIRONMENT (never
// argv), and writes a snapshot. If the password did not arrive, it fails loudly
// rather than letting the leak test pass for the wrong reason.
const STUB = `#!/usr/bin/env node
import fs from 'node:fs';
const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : null; };
if (argv.some((a) => a === '--password' || String(a).includes(${JSON.stringify(SECRET)}))) {
  process.stderr.write('the password reached the worker through argv\\n');
  process.exit(9);
}
const envName = opt('password-env');
if (process.env[envName] !== ${JSON.stringify(SECRET)}) {
  process.stderr.write('the password did NOT reach the worker through the environment\\n');
  process.exit(9);
}
fs.writeFileSync(process.env.CASCADE_TEST_ARGV_LOG, JSON.stringify(argv) + '\\n');
const records = ${JSON.stringify(SNAPSHOT_RECORDS)};
fs.writeFileSync(opt('out'), records.map((r) => JSON.stringify(r)).join('\\n') + '\\n');
process.stderr.write(JSON.stringify({ level: 'info', code: 'summary', tables: 1 }) + '\\n');
`;

function makeProject(dir) {
  fs.mkdirSync(path.join(dir, 'src/main/resources'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src/main/resources/mapper'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/main/resources/application.yml'), YML, 'utf8');
  fs.writeFileSync(path.join(dir, 'src/main/resources/mapper/OrderMapper.xml'), MAPPER, 'utf8');
  const git = (args) => execFileSync('git', ['-C', dir, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...GIT_ENV },
  });
  git(['init', '-q']);
  git(['add', '-A']);
  git(['commit', '-qm', 'shop']);
}

function makeSandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-catalog-'));
  const root = path.join(base, 'shop');
  fs.mkdirSync(root, { recursive: true });
  makeProject(root);
  const stub = path.join(base, 'stub-worker.mjs');
  fs.writeFileSync(stub, STUB, 'utf8');
  const env = {
    ...process.env,
    CASCADE_HOME: path.join(base, 'home'),
    XDG_CACHE_HOME: path.join(base, 'cache'),
    CASCADE_CATALOG_WORKER: stub,
    CASCADE_TEST_ARGV_LOG: path.join(base, 'argv.json'),
    [PASSWORD_ENV]: SECRET,
  };
  // The developer running this suite may have their own password variable
  // exported; the lookup order would then take a different branch here than in
  // CI. Every test that wants it sets it itself.
  delete env.CASCADE_DB_PASSWORD;
  return { base, root, env };
}

const run = (env, args, cwd) => spawnSync(process.execPath, [CLI, ...args], {
  cwd: cwd ?? process.cwd(), env, encoding: 'utf8',
});

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.isFile()) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The signpost: what `cascade init` says when this tree has no schema.
// ---------------------------------------------------------------------------

test('init ends with the signpost when there is no schema, naming the candidate and all three ways out', () => {
  const { root, env } = makeSandbox();
  const r = run(env, ['init', '--root', root, '--project', 'shop']);
  assert.equal(r.status, 0, r.stderr);

  // What is missing, and what it costs. Not one info line among a dozen.
  assert.match(r.stderr, /NO DATABASE SCHEMA IN THIS TREE/);
  assert.match(r.stderr, /draw a single relationship line on the ERD/);
  assert.match(r.stderr, /expand SELECT \* into the columns it really reads/);
  assert.match(r.stderr, /answer a column question in full/);

  // The three ways forward, each with the command that does it.
  assert.match(r.stderr, /cascade analyze --ddl path\/to\/schema\.sql/);
  assert.match(r.stderr, /cascade catalog fetch --candidate 1/);
  assert.match(r.stderr, /cascade estimate/);

  // The candidate, named the way `catalog discover` numbers it, and WITHOUT the
  // password: the signpost is about the schema.
  assert.match(r.stderr, /\[1\] mysql db\.example\.com:3306\/shop as user shop_app/);
  assert.match(r.stderr, /read from src\/main\/resources\/application\.yml/);
  assert.equal(r.stderr.includes(SECRET), false, 'the signpost must not carry the password');
  assert.equal(r.stdout.includes(SECRET), false);

  // The signpost is LAST: the diagnostic that records the find is still there,
  // and the block is what the reader is left looking at.
  assert.match(r.stderr, /CATALOG_CONNECTION_FOUND/);
  assert.ok(r.stderr.indexOf('NO DATABASE SCHEMA') > r.stderr.indexOf('CATALOG_CONNECTION_FOUND'),
    'the signpost must come after the diagnostics, not before them');

  // Nothing was connected to, and nothing was turned on.
  const profile = JSON.parse(fs.readFileSync(path.join(root, '.cascade', 'profile.json'), 'utf8'));
  assert.equal(profile.catalog.source, 'none');
  assert.equal(fs.existsSync(env.CASCADE_TEST_ARGV_LOG), false, 'init connects to nothing');
});

test('init prints NO signpost when the repository ships a schema — there is nothing to point at', () => {
  const { root, env } = makeSandbox();
  fs.mkdirSync(path.join(root, 'db'), { recursive: true });
  fs.writeFileSync(path.join(root, 'db', 'schema.sql'),
    'CREATE TABLE shop_order (\n  id BIGINT NOT NULL,\n  order_sn VARCHAR(64)\n);\n', 'utf8');
  execFileSync('git', ['-C', root, 'add', '-A'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...GIT_ENV } });
  execFileSync('git', ['-C', root, 'commit', '-qm', 'schema'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...GIT_ENV } });

  const r = run(env, ['init', '--root', root, '--project', 'shop']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(/NO DATABASE SCHEMA IN THIS TREE/.test(r.stderr), false, r.stderr);
  const profile = JSON.parse(fs.readFileSync(path.join(root, '.cascade', 'profile.json'), 'utf8'));
  assert.equal(profile.catalog.source, 'file');
});

// ---------------------------------------------------------------------------

test('catalog discover lists candidates with an index and redacts the password', () => {
  const { root, env } = makeSandbox();
  const r = run(env, ['catalog', 'discover', '--root', root]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /connection-info candidates under .*: 1/);
  assert.match(r.stdout, /\[1\] src\/main\/resources\/application\.yml {2}\(spring-yml\)/);
  assert.match(r.stdout, /mysql db\.example\.com:3306\/shop: user shop_app, password present \(<literal in file>\)/);
  assert.equal(r.stdout.includes(SECRET), false, 'the password value must not be printed');
  assert.equal(r.stderr.includes(SECRET), false, 'the password value must not be printed');
  // It listed a target; it did not connect to one.
  assert.match(r.stdout, /Nothing above has been connected to/);
});

test('catalog discover --json carries the same candidates, still redacted', () => {
  const { root, env } = makeSandbox();
  const r = run(env, ['catalog', 'discover', '--root', root, '--json']);
  assert.equal(r.status, 0, r.stderr);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.schema, 'cascade:catalog-candidates:1');
  assert.equal(doc.candidates.length, 1);
  assert.equal(doc.candidates[0].passwordPresent, true);
  assert.equal(doc.candidates[0].passwordRef, '<literal in file>');
  assert.equal(r.stdout.includes(SECRET), false);
});

test('catalog fetch REFUSES to connect without --yes, and says exactly what it would have done', () => {
  const { root, env } = makeSandbox();
  assert.equal(run(env, ['init', '--root', root, '--project', 'shop']).status, 0);
  const r = run(env, ['catalog', 'fetch', '--root', root, '--candidate', '1', '--password-env', PASSWORD_ENV]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /would open a READ-ONLY connection to:/);
  assert.match(r.stderr, /mysql db\.example\.com:3306\/shop/);
  assert.match(r.stderr, /as user {6}shop_app/);
  assert.match(r.stderr, new RegExp(`environment variable ${PASSWORD_ENV}`));
  assert.match(r.stderr, /Refusing to connect: pass --yes/);
  assert.match(r.stderr, /untrusted input/);
  assert.equal(r.stderr.includes(SECRET), false);
  // Nothing was written.
  assert.equal(fs.existsSync(path.join(root, '.cascade', 'catalog', 'columns.jsonl')), false);
  assert.equal(fs.existsSync(env.CASCADE_TEST_ARGV_LOG), false, 'the worker must not have run');
});

test('catalog fetch --yes pins a snapshot with provenance, and never writes a credential', () => {
  const { base, root, env } = makeSandbox();
  assert.equal(run(env, ['init', '--root', root, '--project', 'shop']).status, 0);
  const r = run(env, ['catalog', 'fetch', '--root', root, '--candidate', '1', '--password-env', PASSWORD_ENV, '--yes']);
  assert.equal(r.status, 0, r.stderr);

  const columns = path.join(root, '.cascade', 'catalog', 'columns.jsonl');
  const provFile = path.join(root, '.cascade', 'catalog', 'snapshot.json');
  assert.ok(fs.existsSync(columns), 'columns.jsonl');
  assert.ok(fs.existsSync(provFile), 'snapshot.json');

  const prov = JSON.parse(fs.readFileSync(provFile, 'utf8'));
  assert.equal(prov.schema, 'cascade:catalog-provenance:1');
  assert.equal(prov.dialect, 'mysql');
  assert.equal(prov.serverVersion, '8.0.36');
  assert.equal(prov.serverIdentity, 'db.example.com:3306/shop');
  assert.equal(prov.fetchedAt, '2026-01-02T03:04:05Z');
  assert.equal(prov.candidate, 'src/main/resources/application.yml');
  assert.match(prov.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(prov.rowCounts, { tables: 1, columns: 2, commented: 1 });
  assert.equal(prov.serverIdentity.includes('shop_app'), false, 'the user is not part of the identity');

  // The password travelled through the environment ONLY: the stub exits 9 if it
  // arrived in argv, and the recorded argv is checked here as well.
  const argv = JSON.parse(fs.readFileSync(env.CASCADE_TEST_ARGV_LOG, 'utf8'));
  assert.equal(argv.includes('--password-env'), true);
  assert.equal(argv.some((a) => String(a).includes(SECRET)), false, 'the password reached argv');

  // THE PROFILE IS FINISHED BY THE FETCH. A snapshot nothing reads is not a
  // schema, and the hand edit that used to be required only ever produced an
  // empty ERD and a puzzled reader. The write is narrow: the source, and the
  // candidate file the target came from. Everything else is untouched.
  const profile = JSON.parse(fs.readFileSync(path.join(root, '.cascade', 'profile.json'), 'utf8'));
  assert.equal(profile.catalog.source, 'jdbc');
  assert.equal(profile.catalog.connectionFrom, 'src/main/resources/application.yml');
  assert.deepEqual(profile.frameworkPacks, ['mybatis-xml'], 'the rest of the profile is untouched');
  assert.match(r.stderr, /wrote "catalog": \{ "source": "jdbc", "connectionFrom": "src\/main\/resources\/application\.yml" \}/);

  // …AND THE LEAK TEST: every byte under .cascade/, plus both captured streams.
  const files = walk(path.join(root, '.cascade'));
  assert.ok(files.length >= 4, 'expected the project state to hold files');
  const hits = [];
  for (const f of files) {
    if (fs.readFileSync(f, 'utf8').includes(SECRET)) hits.push(f);
  }
  if (r.stdout.includes(SECRET)) hits.push('<stdout>');
  if (r.stderr.includes(SECRET)) hits.push('<stderr>');
  assert.deepEqual(hits, [], `the password ${SECRET} was written to: ${hits.join(', ')}`);
  // The sandbox outside .cascade/ too (the temp partial file, the registry).
  const outside = walk(path.join(base, 'home')).filter((f) => fs.readFileSync(f, 'utf8').includes(SECRET));
  assert.deepEqual(outside, [], 'the home registry must not carry a credential either');
  assert.equal(fs.existsSync(path.join(root, '.cascade', 'catalog', '.columns.jsonl.partial')), false,
    'the temporary partial file is renamed away, not left behind');
});

test('catalog fetch --url reads the target out of the URL, and never its password', () => {
  const { root, env } = makeSandbox();
  assert.equal(run(env, ['init', '--root', root, '--project', 'shop']).status, 0);
  const r = run(env, [
    'catalog', 'fetch', '--root', root,
    // A password smuggled into the URL is stripped, not used: the password
    // comes from the environment variable, always.
    '--url', `jdbc:postgresql://app:${SECRET}@pg.example.com:5432/shop`,
    '--password-env', PASSWORD_ENV, '--yes',
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /postgres pg\.example\.com:5432\/shop/);
  assert.match(r.stderr, /as user {6}app/);
  assert.equal(r.stderr.includes(SECRET), false, 'the URL password must not be echoed');

  const argv = JSON.parse(fs.readFileSync(env.CASCADE_TEST_ARGV_LOG, 'utf8'));
  assert.equal(argv.some((a) => String(a).includes(SECRET)), false);
  assert.deepEqual(
    ['dialect', 'host', 'port', 'database', 'user'].map((k) => argv[argv.indexOf(`--${k}`) + 1]),
    ['postgres', 'pg.example.com', '5432', 'shop', 'app'],
  );
  const prov = JSON.parse(fs.readFileSync(path.join(root, '.cascade', 'catalog', 'snapshot.json'), 'utf8'));
  assert.equal(prov.candidate, null, 'a hand-typed URL came from no candidate file');
  const leaked = walk(path.join(root, '.cascade')).filter((f) => fs.readFileSync(f, 'utf8').includes(SECRET));
  assert.deepEqual(leaked, []);
});

test('catalog fetch refuses a --url that is not a connection URL', () => {
  const { root, env } = makeSandbox();
  assert.equal(run(env, ['init', '--root', root, '--project', 'shop']).status, 0);
  const r = run(env, ['catalog', 'fetch', '--root', root, '--url', 'https://example.com/db', '--user', 'u', '--yes']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /is not a connection URL/);
  assert.equal(fs.existsSync(env.CASCADE_TEST_ARGV_LOG), false);
});

test('catalog fetch refuses a target it cannot fully name, instead of connecting to a default', () => {
  const { root, env } = makeSandbox();
  assert.equal(run(env, ['init', '--root', root, '--project', 'shop']).status, 0);
  const r = run(env, ['catalog', 'fetch', '--root', root, '--dialect', 'mysql', '--host', 'h', '--yes']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /connection target is incomplete \(missing: database, user\)/);
  assert.equal(fs.existsSync(env.CASCADE_TEST_ARGV_LOG), false);
});

test('catalog fetch with an out-of-range --candidate names how many there were', () => {
  const { root, env } = makeSandbox();
  assert.equal(run(env, ['init', '--root', root, '--project', 'shop']).status, 0);
  const r = run(env, ['catalog', 'fetch', '--root', root, '--candidate', '7', '--yes']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--candidate "7" is not one of the 1 candidate\(s\)/);
});

test('catalog fetch with an empty password variable stops before the worker runs', () => {
  const { root, env } = makeSandbox();
  assert.equal(run(env, ['init', '--root', root, '--project', 'shop']).status, 0);
  const r = run({ ...env, [PASSWORD_ENV]: '' }, [
    'catalog', 'fetch', '--root', root, '--candidate', '1', '--password-env', PASSWORD_ENV, '--yes',
  ]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, new RegExp(`environment variable ${PASSWORD_ENV} is empty`));
  assert.equal(fs.existsSync(env.CASCADE_TEST_ARGV_LOG), false);
});

// ---------------------------------------------------------------------------
// analyze against the pinned snapshot (SPEC §2.3, §17.2)
// ---------------------------------------------------------------------------

function setProfileSource(root, source) {
  const file = path.join(root, '.cascade', 'profile.json');
  const profile = JSON.parse(fs.readFileSync(file, 'utf8'));
  profile.catalog = { ...profile.catalog, source };
  fs.writeFileSync(file, JSON.stringify(profile, null, 2) + '\n', 'utf8');
}

test('analyze with catalog.source=jdbc and no snapshot fails with db-catalog-missing', () => {
  const { root, env } = makeSandbox();
  assert.equal(run(env, ['init', '--root', root, '--project', 'shop']).status, 0);
  setProfileSource(root, 'jdbc');
  const r = run(env, ['analyze', '--root', root, '--project', 'shop', '--no-java']);
  assert.equal(r.status, 2);
  const line = r.stderr.split('\n').find((l) => l.startsWith('{"error":"db-catalog-missing"'));
  assert.ok(line, `expected a structured db-catalog-missing line, got:\n${r.stderr}`);
  const doc = JSON.parse(line);
  assert.equal(doc.error, 'db-catalog-missing');
  assert.match(doc.expected, /\.cascade\/catalog\/columns\.jsonl$/);
  assert.match(doc.remedy, /cascade catalog fetch/);
  assert.match(r.stderr, /never connects to a database/);
});

test('analyze with a pinned snapshot ships the catalog axis and records its provenance', () => {
  const { root, env } = makeSandbox();
  assert.equal(run(env, ['init', '--root', root, '--project', 'shop']).status, 0);
  assert.equal(run(env, ['catalog', 'fetch', '--root', root, '--candidate', '1', '--password-env', PASSWORD_ENV, '--yes']).status, 0);
  setProfileSource(root, 'jdbc');

  // No mapper lane and no Java lane: this run needs neither Python nor a JDK,
  // because the catalog it reads is a FILE that was fetched earlier.
  const r = run(env, ['analyze', '--root', root, '--project', 'shop', '--no-java', '--no-mappers']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /catalog .*columns\.jsonl \(pinned snapshot, mysql db\.example\.com:3306\/shop fetched 2026-01-02T03:04:05Z\)/);
  assert.match(r.stderr, /SQL lane: catalog \(pinned snapshot\)/);

  const pack = JSON.parse(fs.readFileSync(path.join(root, '.cascade', 'pack', 'pack.json'), 'utf8'));
  assert.equal(pack.meta.axes.catalog.status, 'shipped');
  assert.deepEqual(pack.meta.catalog, {
    source: 'snapshot',
    fetchedAt: '2026-01-02T03:04:05Z',
    serverIdentity: 'db.example.com:3306/shop',
    sha256: JSON.parse(fs.readFileSync(path.join(root, '.cascade', 'catalog', 'snapshot.json'), 'utf8')).sha256,
  });
  // The tables and columns of the snapshot are in the graph.
  const ids = pack.nodes.map((n) => n.id);
  assert.ok(ids.includes('table:shop_order'), 'the snapshot table is a node');
  assert.ok(ids.includes('column:shop_order.order_sn'), 'the snapshot column is a node');
  // And the credential still is not anywhere.
  const leaked = walk(path.join(root, '.cascade')).filter((f) => fs.readFileSync(f, 'utf8').includes(SECRET));
  assert.deepEqual(leaked, [], 'a pack built from a snapshot must not carry the credential');
});

test('a refetched snapshot with the same schema changes the file hash but not the catalog digest', () => {
  const { root, env } = makeSandbox();
  assert.equal(run(env, ['init', '--root', root, '--project', 'shop']).status, 0);
  assert.equal(run(env, ['catalog', 'fetch', '--root', root, '--candidate', '1', '--password-env', PASSWORD_ENV, '--yes']).status, 0);
  setProfileSource(root, 'jdbc');
  assert.equal(run(env, ['analyze', '--root', root, '--project', 'shop', '--no-java', '--no-mappers']).status, 0);
  const first = JSON.parse(fs.readFileSync(path.join(root, '.cascade', 'pack', 'pack.json'), 'utf8'));

  // Refetch: the header's fetchedAt is what a real refetch changes. The pack's
  // DIGEST is over the graph, so an unchanged schema keeps it — which is the
  // point of pinning (SPEC §17.2).
  const columns = path.join(root, '.cascade', 'catalog', 'columns.jsonl');
  const lines = fs.readFileSync(columns, 'utf8').split('\n').filter(Boolean);
  const header = JSON.parse(lines[0]);
  header.fetchedAt = '2026-02-02T00:00:00Z';
  fs.writeFileSync(columns, [JSON.stringify(header), ...lines.slice(1)].join('\n') + '\n', 'utf8');

  assert.equal(run(env, ['analyze', '--root', root, '--project', 'shop', '--no-java', '--no-mappers']).status, 0);
  const second = JSON.parse(fs.readFileSync(path.join(root, '.cascade', 'pack', 'pack.json'), 'utf8'));
  assert.equal(second.digest, first.digest, 'the same schema must produce the same pack digest');

  // …and the other direction, which is the half that would go unnoticed: a
  // schema that DID change must move the digest. A pinned snapshot that could
  // not invalidate anything would be a cache, not a source of truth.
  const changed = fs.readFileSync(columns, 'utf8')
    .replace('"comment":"Order code"', '"comment":"Order code — unique per tenant"');
  fs.writeFileSync(columns, changed, 'utf8');
  const third = run(env, ['analyze', '--root', root, '--project', 'shop', '--no-java', '--no-mappers', '--accept-baseline']);
  assert.equal(third.status, 0, third.stderr);
  // The snapshot was edited by hand, so it no longer matches the provenance the
  // fetch recorded. The file on disk is what was analyzed, and the pack says so
  // rather than travelling under the old fetch's hash.
  assert.match(third.stderr, /SNAPSHOT_PROVENANCE_STALE/);
  const after = JSON.parse(fs.readFileSync(path.join(root, '.cascade', 'pack', 'pack.json'), 'utf8'));
  assert.notEqual(after.digest, first.digest, 'a changed column comment must change the pack');
  assert.notEqual(after.meta.catalog.sha256, first.meta.catalog.sha256);
});

// ---------------------------------------------------------------------------
// The reminder: a run on a recorded-but-unfetched connection says so, ONCE, at
// the top, and still produces its pack. A partial answer is a supported answer.
// ---------------------------------------------------------------------------

const VENV_PY = path.join(ENGINE_ROOT, '.venv', 'bin', 'python');

test('analyze on a recorded-but-unfetched connection prints one reminder and still writes the pack', (t) => {
  if (!fs.existsSync(VENV_PY)) {
    t.skip(`no venv python at ${VENV_PY} — the mapper lane cannot run (see docs/setup/sql-lane.md)`);
    return;
  }
  const { root, env } = makeSandbox();
  assert.equal(run(env, ['init', '--root', root, '--project', 'shop']).status, 0);

  const r = run(env, ['analyze', '--root', root, '--project', 'shop', '--no-java']);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stderr.split('\n').filter((l) => l.startsWith('no schema has been fetched'));
  assert.equal(lines.length, 1, `expected exactly one reminder, got ${lines.length}:\n${r.stderr}`);
  assert.match(lines[0], /records a database at src\/main\/resources\/application\.yml/);
  assert.match(lines[0], /no ERD relationship lines and partial column answers/);
  assert.match(lines[0], /cascade catalog fetch --candidate 1/);
  // At the TOP: before the lane census, not after the pack was already built.
  assert.ok(r.stderr.indexOf('no schema has been fetched') < r.stderr.indexOf('lanes ['),
    'the reminder must come before the lane line');
  // And the run finished: a missing schema costs answers, it does not stop one.
  assert.ok(fs.existsSync(path.join(root, '.cascade', 'pack', 'pack.json')), 'the pack is still written');
});

test('analyze says nothing of the kind once a snapshot is pinned', (t) => {
  if (!fs.existsSync(VENV_PY)) {
    t.skip(`no venv python at ${VENV_PY} — the mapper lane cannot run (see docs/setup/sql-lane.md)`);
    return;
  }
  const { root, env } = makeSandbox();
  assert.equal(run(env, ['init', '--root', root, '--project', 'shop']).status, 0);
  assert.equal(run(env, ['catalog', 'fetch', '--root', root, '--candidate', '1', '--password-env', PASSWORD_ENV, '--yes']).status, 0);

  const r = run(env, ['analyze', '--root', root, '--project', 'shop', '--no-java']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr.includes('no schema has been fetched'), false, r.stderr);
  assert.match(r.stderr, /catalog .*columns\.jsonl \(pinned snapshot/);
});

// ---------------------------------------------------------------------------
// Where the password comes from, in order.
// ---------------------------------------------------------------------------

const CRED_LINE = (password) => JSON.stringify({
  server: 'mysql://db.example.com:3306/shop', user: 'shop_app', password,
}) + '\n';

/** Write a credentials file at 0600 into this sandbox's home. */
function writeCredFile(env, password) {
  fs.mkdirSync(env.CASCADE_HOME, { recursive: true });
  const file = path.join(env.CASCADE_HOME, 'credentials');
  fs.writeFileSync(file, CRED_LINE(password), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

test('fetch takes the password from the credentials file when no variable names one', () => {
  const { root, env } = makeSandbox();
  assert.equal(run(env, ['init', '--root', root, '--project', 'shop']).status, 0);
  const file = writeCredFile(env, SECRET);

  const r = run(env, ['catalog', 'fetch', '--root', root, '--candidate', '1', '--yes']);
  assert.equal(r.status, 0, r.stderr);
  // The confirmation names the FILE as the source, and never its contents.
  assert.match(r.stderr, new RegExp(`password *from ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(mode 0600`));
  assert.equal(r.stderr.includes(SECRET), false);
  // The stub exits 9 unless the password arrived through the environment, so a
  // status of 0 IS the proof that the file's secret reached the worker that way.
  const argv = JSON.parse(fs.readFileSync(env.CASCADE_TEST_ARGV_LOG, 'utf8'));
  assert.equal(argv[argv.indexOf('--password-env') + 1], 'CASCADE_DB_PASSWORD');
  assert.equal(argv.some((a) => String(a).includes(SECRET)), false);
});

test('the environment beats the file, and --password-env beats both', () => {
  const { root, env } = makeSandbox();
  assert.equal(run(env, ['init', '--root', root, '--project', 'shop']).status, 0);
  // The file holds a DIFFERENT password. The stub fails unless the one that
  // arrives is SECRET, so "which source won" is not a matter of reading a line.
  writeCredFile(env, 'pw-FROM-THE-FILE');

  const viaDefault = run({ ...env, CASCADE_DB_PASSWORD: SECRET }, ['catalog', 'fetch', '--root', root, '--candidate', '1', '--yes']);
  assert.equal(viaDefault.status, 0, viaDefault.stderr);
  assert.match(viaDefault.stderr, /password *from the environment variable CASCADE_DB_PASSWORD/);

  // ...and the named variable outranks the default variable AND the file.
  const viaNamed = run(
    { ...env, CASCADE_DB_PASSWORD: 'pw-FROM-THE-DEFAULT-VARIABLE', [PASSWORD_ENV]: SECRET },
    ['catalog', 'fetch', '--root', root, '--candidate', '1', '--password-env', PASSWORD_ENV, '--yes'],
  );
  assert.equal(viaNamed.status, 0, viaNamed.stderr);
  assert.match(viaNamed.stderr, new RegExp(`password *from the environment variable ${PASSWORD_ENV}`));
});

test('with no variable, no entry and no terminal, fetch dies naming all four sources', () => {
  const { root, env } = makeSandbox();
  assert.equal(run(env, ['init', '--root', root, '--project', 'shop']).status, 0);
  const r = run(env, ['catalog', 'fetch', '--root', root, '--candidate', '1', '--yes']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no password for this connection, and no terminal to ask on/);
  assert.match(r.stderr, /1\. the variable named by --password-env <NAME>/);
  assert.match(r.stderr, /2\. the environment variable CASCADE_DB_PASSWORD/);
  assert.match(r.stderr, /3\. an entry in .*credentials for mysql:\/\/db\.example\.com:3306\/shop as user shop_app/);
  assert.match(r.stderr, /4\. a hidden prompt, when a terminal is attached/);
  assert.equal(fs.existsSync(env.CASCADE_TEST_ARGV_LOG), false, 'the worker must not have run');
});

test('a credentials file the group can read stops the fetch, with the chmod to run', () => {
  const { root, env } = makeSandbox();
  assert.equal(run(env, ['init', '--root', root, '--project', 'shop']).status, 0);
  const file = writeCredFile(env, SECRET);
  fs.chmodSync(file, 0o644);

  const r = run(env, ['catalog', 'fetch', '--root', root, '--candidate', '1', '--yes']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /is mode 0644, which lets other accounts on this machine read it/);
  assert.match(r.stderr, new RegExp(`Run: chmod 600 ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.equal(r.stderr.includes(SECRET), false);
  assert.equal(fs.existsSync(env.CASCADE_TEST_ARGV_LOG), false, 'nothing connected');
});
