import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROUTES_FILE, ROUTES_SCHEMA } from '../src/mcp/federation.mjs';
import { skipWithoutSqlLane } from './helpers/lane_prereqs.mjs';

// WHAT `cascade analyze` WRITES INTO routes.json (RM46).
//
// The sidecar is what one project's server reads to answer "who serves this?"
// about another, and the one field in it that a path and a method cannot
// supply is the service NAME. This drives the REAL CLI, because the question
// under test is how the profile and the run's own discovery meet each other,
// and a unit test of either half would have passed while the wiring was wrong.
//
// The pack itself is not in question here, and that is asserted too: the name
// rides beside the pack, never in it, so the digest is the same either way.

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ENGINE_ROOT, 'bin', 'cascade.mjs');

const DDL = 'CREATE TABLE `thing` (`id` bigint NOT NULL, `name` varchar(40)) ENGINE=InnoDB;\n';
const APPLICATION_YML = `spring:
  application:
    name: orders-service
  datasource:
    url: jdbc:mysql://db.example.com:3306/shop
`;

function tmpDir(t, prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A committed repository with one table and one Spring configuration file. */
function repo(dir) {
  fs.mkdirSync(path.join(dir, 'src/main/resources'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'db'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/main/resources/application.yml'), APPLICATION_YML, 'utf8');
  fs.writeFileSync(path.join(dir, 'db/schema.sql'), DDL, 'utf8');
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.email=dev@example.com', '-c', 'user.name=dev', 'commit', '-qm', 'init');
  return dir;
}

/** Run the CLI, capturing stderr even on success. */
function run(t, args, env, root) {
  const log = path.join(tmpDir(t, 'cascade-sidecar-log-'), 'stderr.txt');
  const fd = fs.openSync(log, 'w');
  let code = 0;
  try {
    execFileSync(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...env }, cwd: root, stdio: ['ignore', 'ignore', fd], maxBuffer: 1 << 28,
    });
  } catch (e) {
    code = e.status ?? 1;
  } finally {
    fs.closeSync(fd);
  }
  return { code, stderr: fs.readFileSync(log, 'utf8') };
}

const sidecarOf = (root) => JSON.parse(fs.readFileSync(path.join(root, '.cascade', 'pack', ROUTES_FILE), 'utf8'));
const digestOf = (root) => JSON.parse(fs.readFileSync(path.join(root, '.cascade', 'pack', 'pack.json'), 'utf8')).digest;

test('a profile with no serviceNames: the sidecar takes the name THIS RUN read, and the run says so', (t) => {
  if (skipWithoutSqlLane(t)) return;
  const base = tmpDir(t, 'cascade-sidecar-');
  const home = path.join(base, 'home');
  const root = repo(path.join(base, 'orders'));

  const init = run(t, ['init', '--root', root, '--project', 'orders'], { CASCADE_HOME: home }, base);
  assert.equal(init.code, 0, init.stderr);

  // A PROFILE FROM BEFORE THIS ROUND: the key is not there at all, which is
  // what every project analyzed before RM46 looks like.
  const profileFile = path.join(root, '.cascade', 'profile.json');
  const profile = JSON.parse(fs.readFileSync(profileFile, 'utf8'));
  assert.deepEqual(profile.serviceNames, ['orders-service'], '`init` records it');
  delete profile.serviceNames;
  fs.writeFileSync(profileFile, JSON.stringify(profile, null, 2) + '\n', 'utf8');

  const first = run(t, ['analyze', '--root', root, '--project', 'orders', '--no-java', '--no-mappers'], { CASCADE_HOME: home }, base);
  assert.equal(first.code, 0, first.stderr);
  const sidecar = sidecarOf(root);
  assert.equal(sidecar.schema, ROUTES_SCHEMA);
  assert.deepEqual(sidecar.serviceNames, ['orders-service'],
    'the name is in the tree this run walked, so the sidecar has no reason to be empty');
  // ...and the run says the name is not recorded, with the command that records
  // it. A name only this run knows goes away the next time the tree changes.
  const said = first.stderr.split('\n').find((l) => l.startsWith('service name(s)'));
  assert.ok(said, `no service line in:\n${first.stderr}`);
  assert.match(said, /service name\(s\) \[orders-service\]/);
  assert.match(said, /discovered in src\/main\/resources\/application\.yml/);
  assert.match(said, /not in the profile: run `cascade init --force` to record it/);

  // THE PACK IS THE SAME EITHER WAY. Put the name back in the profile and
  // re-run: the sidecar says the same thing for a different reason, the line
  // stops calling it discovered, and the digest has not moved.
  const before = digestOf(root);
  fs.writeFileSync(profileFile, JSON.stringify({ ...profile, serviceNames: ['orders-service'] }, null, 2) + '\n', 'utf8');
  const second = run(t, ['analyze', '--root', root, '--project', 'orders', '--no-java', '--no-mappers'], { CASCADE_HOME: home }, base);
  assert.equal(second.code, 0, second.stderr);
  assert.deepEqual(sidecarOf(root).serviceNames, ['orders-service']);
  assert.equal(digestOf(root), before, 'the name lives beside the pack, never in it');
  const saidAgain = second.stderr.split('\n').find((l) => l.startsWith('service name(s)'));
  assert.match(saidAgain, /service name\(s\) \[orders-service\]; gateway routes 0/);
  assert.equal(/discovered in/.test(saidAgain), false, saidAgain);
});

test('a profile that declares its own names keeps them, whatever the tree says', (t) => {
  if (skipWithoutSqlLane(t)) return;
  const base = tmpDir(t, 'cascade-sidecar-declared-');
  const home = path.join(base, 'home');
  const root = repo(path.join(base, 'orders'));

  assert.equal(run(t, ['init', '--root', root, '--project', 'orders'], { CASCADE_HOME: home }, base).code, 0);
  const profileFile = path.join(root, '.cascade', 'profile.json');
  const profile = JSON.parse(fs.readFileSync(profileFile, 'utf8'));
  fs.writeFileSync(profileFile, JSON.stringify({ ...profile, serviceNames: ['the-name-i-deploy-under'] }, null, 2) + '\n', 'utf8');

  const r = run(t, ['analyze', '--root', root, '--project', 'orders', '--no-java', '--no-mappers'], { CASCADE_HOME: home }, base);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(sidecarOf(root).serviceNames, ['the-name-i-deploy-under'],
    'the tree says orders-service and the profile outranks it');
  const said = r.stderr.split('\n').find((l) => l.startsWith('service name(s)'));
  assert.match(said, /service name\(s\) \[the-name-i-deploy-under\]/);
  assert.equal(/discovered in/.test(said), false, said);
});
