// petclinic_ms_federation.test.mjs — the crossing on a REAL tree (round RM44).
//
// test/petclinic_ms.test.mjs analyses spring-petclinic-microservices as ONE
// repository, which is what makes its six cross-service calls land on routes
// the same pack serves. That is not the shape teams actually have: five
// services normally live in five repositories and analyse into five packs, and
// then every one of those calls leaves its pack and the chain stops.
//
// So this test builds the five packs SEPARATELY — one git repository per
// service, `cascade init` and `cascade analyze` in each — and asks the
// multi-project server the questions that only a join across packs can answer.
//
// Every expectation is read out of the fixture's source (the file and line are
// in petclinic_ms.test.mjs, which reads the same six calls by hand) or out of
// the split packs themselves, and the counts are the ones a split build really
// produces:
//
//   pack               served  outbound  tables
//   api-gateway             2         2       0   (no DDL in that service)
//   customers-service       8         0       3
//   visits-service          3         0       1
//   vets-service            1         0       3
//   genai-service           1         4       0
//
// The fixture is CLONED and each service COPIED into a repository of its own, so
// nothing outside the temp directory is touched: `cascade init` writes into the
// tree it is given, and the home registry and the shard cache are redirected.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadPack } from '../src/core/pack.mjs';
import { computeTrust } from '../src/core/trust.mjs';
import { registryPath } from '../src/core/paths.mjs';
import { readRegistry } from '../src/core/registry.mjs';
import { createProjectHost } from '../src/mcp/projects.mjs';
import { assertContract } from '../src/mcp/contract.mjs';
import { findJdk } from '../scripts/ci-java-smoke.mjs';

const ENGINE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const CLI = path.join(ENGINE_ROOT, 'bin', 'cascade.mjs');
const VENV_PY = path.join(ENGINE_ROOT, '.venv', 'bin', 'python');

/** The pinned commit — the same one petclinic_ms.test.mjs scores against. */
const PINNED_COMMIT = '3858f9c630cf989bb6809a86edf47c2be78dc9f1';
const FIXTURE = process.env.CASCADE_PETCLINIC_MS
  ?? path.resolve(ENGINE_ROOT, '..', 'target-examples', 'petclinic-ms');

/** project id -> the directory inside the fixture that becomes its repository. */
const SERVICES = [
  ['api-gateway', 'spring-petclinic-api-gateway'],
  ['customers-service', 'spring-petclinic-customers-service'],
  ['visits-service', 'spring-petclinic-visits-service'],
  ['vets-service', 'spring-petclinic-vets-service'],
  ['genai-service', 'spring-petclinic-genai-service'],
];

const A_CLIENT = 'spring-petclinic-api-gateway/src/main/java/org/springframework/samples/petclinic/api/application';

function preflight() {
  if (!fs.existsSync(path.join(FIXTURE, `${A_CLIENT}/CustomersServiceClient.java`))) {
    return `no spring-petclinic-microservices checkout at ${FIXTURE} — clone it at ${PINNED_COMMIT} `
      + '(git clone https://github.com/spring-petclinic/spring-petclinic-microservices) or set CASCADE_PETCLINIC_MS';
  }
  if (!findJdk()) {
    return 'no JDK found: JAVA_HOME is unset and no javac on PATH — the Java lane cannot run (see docs/setup/java-lane.md)';
  }
  if (!fs.existsSync(VENV_PY)) {
    return `no venv python at ${VENV_PY} — the DDL catalog cannot be parsed (see docs/setup/sql-lane.md)`;
  }
  return null;
}

/** The loader the CLI builds, in miniature (bin/cascade.mjs loadServedProject). */
function loadProject(entry) {
  const dir = entry.packDir ?? path.join(entry.dotCascadePath, 'pack');
  const pack = JSON.parse(fs.readFileSync(path.join(dir, 'pack.json'), 'utf8'));
  const graph = loadPack(pack, { verifyDigest: true });
  return {
    graph,
    basis: {
      project: entry.id, buildDigest: pack.digest, builtAt: pack.meta?.builtAt ?? null,
      freshness: { verdict: 'unknown' },
    },
    trust: computeTrust({}),
    limits: [],
    pack: {
      project: pack.meta?.project ?? null, digest: pack.digest, builtAt: pack.meta?.builtAt ?? null,
      lanes: pack.meta?.lanes ?? null, base: pack.meta?.base ?? null, ddl: null,
      axes: pack.meta?.axes ?? null, laneStats: pack.meta?.laneStats ?? null,
    },
  };
}

const shortOf = (id) => String(id).replace('org.springframework.samples.petclinic.', '');

test('petclinic-ms split five ways: the answer crosses from one pack into the next', { timeout: 1800000 }, (t) => {
  const why = preflight();
  if (why) { t.skip(why); return; }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-petclinic-fed-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const env = {
    ...process.env,
    XDG_CACHE_HOME: path.join(work, 'cache'),
    CASCADE_HOME: path.join(work, 'home'),
  };
  const cli = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', maxBuffer: 1 << 28, env });

  // ---- five repositories, five packs -------------------------------------
  const source = path.join(work, 'fixture');
  execFileSync('git', ['clone', '--quiet', '--no-hardlinks', FIXTURE, source], { stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['-C', source, 'checkout', '--quiet', PINNED_COMMIT], { stdio: ['ignore', 'pipe', 'pipe'] });

  const analyzeOut = new Map();
  for (const [id, dir] of SERVICES) {
    const repo = path.join(work, id);
    fs.cpSync(path.join(source, dir), repo, { recursive: true });
    execFileSync('git', ['-C', repo, 'init', '--quiet'], { stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['-C', repo, 'add', '-A'], { stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['-C', repo, '-c', 'user.name=cascade', '-c', 'user.email=cascade@example.invalid',
      'commit', '--quiet', '-m', `petclinic ${id}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    const init = cli(['init', '--root', repo, '--project', id]);
    assert.equal(init.status, 0, init.stderr);
    const an = cli(['analyze', '--root', repo]);
    assert.equal(an.status, 0, an.stderr);
    analyzeOut.set(id, an.stderr);
  }

  // ---- 1. what each pack serves, calls, and holds -------------------------
  // The sidecar is written by `analyze`, one line of its own on stderr, and it
  // is DERIVED from the pack: the digest inside it is the pack's.
  const indexOf = (id) => JSON.parse(fs.readFileSync(path.join(work, id, '.cascade', 'pack', 'routes.json'), 'utf8'));
  const packOf = (id) => JSON.parse(fs.readFileSync(path.join(work, id, '.cascade', 'pack', 'pack.json'), 'utf8'));
  const counted = SERVICES.map(([id]) => {
    const idx = indexOf(id);
    const pack = packOf(id);
    assert.equal(idx.buildDigest, pack.digest, `${id}: the index names the pack it came from`);
    assert.match(analyzeOut.get(id), new RegExp(`routes index: ${idx.serves.length} served, ${idx.calls.length} outbound`));
    return [id, idx.serves.length, idx.calls.length, pack.nodes.filter((n) => n.id.startsWith('table:')).length];
  });
  assert.deepEqual(counted, [
    ['api-gateway', 2, 14, 0],
    ['customers-service', 8, 0, 3],
    ['visits-service', 3, 0, 1],
    ['vets-service', 1, 0, 3],
    ['genai-service', 1, 4, 0],
  ], 'a per-service build reads that service\'s own DDL, not the whole tree\'s');
  // Every call the gateway makes. TWO of them are Java, by hand from
  // CustomersServiceClient.java and VisitsServiceClient.java: one names its
  // service as a literal, the other builds the url from a base this lane does
  // not resolve and claims no name. The other TWELVE are the AngularJS pages
  // under `src/main/resources/static/scripts` (RM47), read with no flag because
  // discovery wrote that directory into the profile's `webRoots`; each one
  // carries the service the gateway's own route table forwards its prefix to.
  assert.deepEqual(indexOf('api-gateway').calls.map((c) => [c.method, c.path, c.service]), [
    ['GET', '/owners', 'customers-service'],
    ['GET', '/owners/{*}', 'customers-service'],
    ['GET', '/owners/{*}/pets/{*}', 'customers-service'],
    ['GET', '/owners/{*}/pets/{*}/visits', 'visits-service'],
    ['GET', '/owners/{ownerId}', 'customers-service'],
    ['GET', '/petTypes', 'customers-service'],
    ['GET', '/pets/visits', null],
    ['GET', '/vets', 'vets-service'],
    ['POST', '/chatclient', 'genai-service'],
    ['POST', '/owners', 'customers-service'],
    ['POST', '/owners/{*}/pets', 'customers-service'],
    ['POST', '/owners/{*}/pets/{*}/visits', 'visits-service'],
    ['PUT', '/owners/{*}', 'customers-service'],
    ['PUT', '/owners/{*}/pets/{*}', 'customers-service'],
  ]);

  // ---- the server that holds all five -------------------------------------
  const registry = readRegistry(registryPath(env));
  assert.deepEqual(registry.projects.map((p) => p.id).sort(), SERVICES.map(([id]) => id).sort());
  const host = createProjectHost({ registry, loadProject, log: () => {} });

  // Every project is federated, and the listing says so from the sidecars alone.
  const listed = host.callTool('projects', {}).answer.projects;
  assert.deepEqual(listed.map((p) => [p.id, p.federation.index, p.federation.serves, p.federation.calls]), [
    ['api-gateway', 'present', 2, 14],
    ['customers-service', 'present', 8, 0],
    ['genai-service', 'present', 1, 4],
    ['vets-service', 'present', 1, 0],
    ['visits-service', 'present', 3, 0],
  ]);

  // ---- 2. the gateway's route reaches two other services' tables ----------
  // api-gateway/…/boundary/web/ApiGatewayController.java:54 is
  // @GetMapping("owners/{ownerId}") under @RequestMapping("/api/gateway").
  const flow = host.callTool('flow', { project: 'api-gateway', endpoint: 'GET /api/gateway/owners/{ownerId}' });
  assertContract(flow);
  assert.deepEqual(flow.answer.tables.map((x) => [x.table, x.project, x.grade, x.viaHttp === true]), [
    ['owners', 'customers-service', 'SOUND_SET', true],
    ['visits', 'visits-service', 'SOUND_SET', true],
  ], 'the two tables live in two OTHER packs, and each row names the one it is in');
  // The handler on the far side of each crossing, at the hops the crossing puts
  // it at: the client method is hop 1 here, the route it calls is hop 2, and the
  // controller that answers it is hop 3 over there.
  assert.deepEqual(
    flow.answer.services.filter((s) => s.project).map((s) => [shortOf(s.id), s.project, s.hops]),
    [
      ['customers.web.OwnerResource#findOwner', 'customers-service', 3],
      ['visits.web.VisitResource#read', 'visits-service', 3],
    ],
  );
  assert.deepEqual(flow.answer.federation.crossed.map((c) => [shortOf(c.from.symbol), c.route.path, c.to.project, c.grade]), [
    ['api.application.CustomersServiceClient#getOwner', '/owners/{ownerId}', 'customers-service', 'SOUND_SET'],
    ['api.application.VisitsServiceClient#getVisitsForPets', '/pets/visits', 'visits-service', 'SOUND_SET'],
  ]);
  assert.deepEqual(flow.answer.federation.unmatched, []);
  assert.deepEqual(flow.answer.federation.skipped, []);
  // Both packs the answer walked, each anchored to its OWN snapshot.
  assert.deepEqual(flow.basis.siblings.map((s) => [s.project, s.buildDigest, s.freshness.verdict]), [
    ['customers-service', packOf('customers-service').digest, 'unknown'],
    ['visits-service', packOf('visits-service').digest, 'unknown'],
  ]);
  // ...and with federation off, the same question stops where one pack stops.
  const alone = host.callTool('flow', { project: 'api-gateway', endpoint: 'GET /api/gateway/owners/{ownerId}', federate: false });
  assert.deepEqual(alone.answer.tables, []);
  assert.equal(alone.answer.empty.tables, 'none');

  // ---- 3. and back the other way, out of customers-service ---------------
  // `owners.id` is the column OwnerRepository.findById reads, so the gateway's
  // own route is upstream of it, through the crossing.
  const impact = host.callTool('endpoint_impact', { project: 'customers-service', column: 'owners.id' });
  assertContract(impact);
  assert.deepEqual(impact.answer.endpoints.map((e) => [e.id, e.project ?? 'customers-service']), [
    ['GET /api/gateway/owners/{ownerId}', 'api-gateway'],
    ['GET /owners/{ownerId}', 'customers-service'],
    ['POST /owners/{ownerId}/pets', 'customers-service'],
    ['PUT /owners/{ownerId}', 'customers-service'],
  ]);
  assert.deepEqual(impact.basis.siblings.map((s) => s.project), ['api-gateway', 'genai-service']);
  // genai-service calls POST /owners/{ownerId}/pets too. It reaches no route of
  // its own — the Spring AI tool methods above `AIDataProvider` are wired to the
  // chat client at run time, not by a call this lane can see — so the crossing
  // is REPORTED and contributes no row. A crossing with nothing above it is
  // still a crossing, and the answer says it happened.
  assert.deepEqual(
    impact.answer.federation.crossed.map((c) => [c.from.project, shortOf(c.from.symbol), c.route.path, c.to.endpoint]),
    [
      ['api-gateway', 'api.application.CustomersServiceClient#getOwner', '/owners/{ownerId}', 'GET /owners/{ownerId}'],
      // The gateway's own pages ask for the same owner (RM47): two controllers,
      // two crossings, both onto the route customers-service serves.
      ['api-gateway', 'src/main/resources/static/scripts/owner-form/owner-form.controller.js#(module)', '/owners/{*}', 'GET /owners/{ownerId}'],
      ['api-gateway', 'src/main/resources/static/scripts/pet-form/pet-form.controller.js#(module)', '/owners/{*}', 'GET /owners/{ownerId}'],
      ['genai-service', 'genai.AIDataProvider#addPetToOwner', '/owners/{*}/pets', 'POST /owners/{ownerId}/pets'],
    ],
  );

  // ---- 3b. the screens on the far side of the same crossing (RM47) -------
  // The gateway's frontend is in ANOTHER pack, and a column question asked of
  // customers-service still names the screens that show it.
  const screens = host.callTool('screen_impact', { project: 'customers-service', column: 'owners.first_name' });
  assertContract(screens);
  assert.deepEqual(screens.answer.screens.map((s) => [s.screen, s.project, s.grade, s.endpoints]), [
    ['/owners', 'api-gateway', 'SOUND_SET', ['GET /owners']],
    ['/owners/:ownerId/edit', 'api-gateway', 'SOUND_SET', ['POST /owners', 'PUT /owners/{ownerId}']],
    ['/owners/new', 'api-gateway', 'SOUND_SET', ['POST /owners', 'PUT /owners/{ownerId}']],
  ], 'customers-service has no screen of its own, and these three are the gateway\'s');
  assert.deepEqual(screens.basis.siblings.map((s) => s.project), ['api-gateway', 'genai-service']);

  // ---- 4. the project that serves it is not registered -------------------
  const withoutVisits = { projects: registry.projects.filter((p) => p.id !== 'visits-service') };
  const partial = createProjectHost({ registry: withoutVisits, loadProject, log: () => {} });
  const cut = partial.callTool('flow', { project: 'api-gateway', endpoint: 'GET /api/gateway/owners/{ownerId}' });
  assertContract(cut);
  assert.deepEqual(cut.answer.tables.map((x) => [x.table, x.project]), [['owners', 'customers-service']],
    'customers-service is still crossed; visits-service is not there to cross into');
  assert.deepEqual(cut.answer.federation.unmatched.map((u) => [u.route.method, u.route.path, u.checked, u.noIndex]),
    [['GET', '/pets/visits', 3, 0]]);
  const said = cut.limits.filter((l) => l.scope === 'federation');
  assert.equal(said.length, 1);
  assert.match(said[0].reason, /GET \/pets\/visits leaves this project and none of the 3 other registered project\(s\) serves it/);
  assert.match(said[0].reason, /Register the project that serves this route and ask again/);
});
