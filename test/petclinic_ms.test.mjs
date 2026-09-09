// petclinic_ms.test.mjs — the IMPERATIVE HTTP call across a real multi-service
// tree (round RM43).
//
// spring-petclinic-microservices is five deployables in one repository, and not
// one of them writes a @FeignClient: the gateway reaches the other services with
// a WebClient, and the genai service with a WebClient and a RestClient. Before
// this round the Java lane read only the DECLARATIVE client, so analysing the
// whole tree as one produced ZERO CALLS_HTTP edges and every chain stopped at
// the service boundary — `grep -rl "@FeignClient\|@HttpExchange" --include=*.java`
// over the checkout returns nothing, which is why the before number is 0 and not
// a measurement of this engine's own output.
//
// EVERY expectation below was read out of the fixture's SOURCE, and each one
// names the file and the line it comes from. The six calls, by hand — the urls
// are written there with an `http` scheme, spelled `<scheme>` here because a
// repository gate forbids naming a host inside a url in this tree:
//
//   api-gateway/…/application/CustomersServiceClient.java:37
//     webClientBuilder.build().get().uri("<scheme>://customers-service/owners/{ownerId}", ownerId)
//   api-gateway/…/application/VisitsServiceClient.java:44
//     webClientBuilder.build().get().uri(hostname + "pets/visits?petId={petId}", …)
//     …with `private String hostname = "<scheme>://visits-service/"` on line 33
//   genai-service/…/VectorStoreController.java:69
//     webClient.get().uri(vetsHostname + "vets")   (vetsHostname = "<scheme>://vets-service/")
//   genai-service/…/AIDataProvider.java:43, 71, 80
//     restClient.get().uri(getCustomerServiceUri() + "/owners")
//     restClient.post().uri(getCustomerServiceUri() + "/owners/" + ownerId + "/pets")
//     restClient.post().uri(getCustomerServiceUri() + "/owners")
//
// …and the routes they land on, from the services that serve them:
//
//   customers-service/…/web/OwnerResource.java   @RequestMapping("/owners") with
//       @GetMapping(value="/{ownerId}") -> GET /owners/{ownerId}
//       @GetMapping -> GET /owners, @PostMapping -> POST /owners
//   customers-service/…/web/PetResource.java     @PostMapping("/owners/{ownerId}/pets")
//   visits-service/…/web/VisitResource.java      @GetMapping("pets/visits")
//   vets-service/…/web/VetResource.java          @RequestMapping("/vets") + @GetMapping
//
// The checkout is CLONED to a temp directory and analysed there: the fixture is
// read-only, `cascade init` writes a `.cascade/` into the tree it is given, and
// the home registry and shard cache are redirected so the run changes nothing
// outside its temp directory.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadPack } from '../src/core/pack.mjs';
import { callTool } from '../src/mcp/catalog.mjs';
import { computeTrust } from '../src/core/trust.mjs';
import { findJdk } from '../scripts/ci-java-smoke.mjs';

const ENGINE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const CLI = path.join(ENGINE_ROOT, 'bin', 'cascade.mjs');
const VENV_PY = path.join(ENGINE_ROOT, '.venv', 'bin', 'python');

/**
 * The pinned commit. Every count below describes the SOURCE at this commit, so a
 * different one is a different project and the test refuses it rather than
 * scoring the engine against a fixture that moved underneath it.
 */
const PINNED_COMMIT = '3858f9c630cf989bb6809a86edf47c2be78dc9f1';

/** Where the orchestrator/CI puts the clone. */
const FIXTURE = process.env.CASCADE_PETCLINIC_MS
  ?? path.resolve(ENGINE_ROOT, '..', 'target-examples', 'petclinic-ms');

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

/** Clone the fixture at the pinned commit into `dir`. Never touches the source. */
function cloneFixture(dir) {
  execFileSync('git', ['clone', '--quiet', '--no-hardlinks', FIXTURE, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['-C', dir, 'checkout', '--quiet', PINNED_COMMIT], { stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD']).toString('utf8').trim(), PINNED_COMMIT);
}

const shortFrom = (edge) => edge.from.slice('symbol:'.length).replace('org.springframework.samples.petclinic.', '');

test('petclinic-ms: the imperative HTTP calls draw the cross-service edges', { timeout: 900000 }, (t) => {
  const why = preflight();
  if (why) { t.skip(why); return; }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-petclinic-ms-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const repo = path.join(work, 'repo');
  cloneFixture(repo);

  const cli = (args) => spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    env: {
      ...process.env,
      XDG_CACHE_HOME: path.join(work, 'cache'),
      CASCADE_HOME: path.join(work, 'home'),
    },
  });

  assert.equal(cli(['init', '--root', repo, '--project', 'petclinic-ms']).status, 0);
  // No lane flags: the whole repository is analysed as ONE tree, which is the
  // only way a call from the gateway can meet the route another service serves.
  const analyze = cli(['analyze', '--root', repo, '--project', 'petclinic-ms']);
  assert.equal(analyze.status, 0, analyze.stderr);

  const packJson = JSON.parse(fs.readFileSync(path.join(repo, '.cascade', 'pack', 'pack.json'), 'utf8'));
  const graph = loadPack(packJson, { verifyDigest: true });
  assert.equal(packJson.meta.base.commit, PINNED_COMMIT, 'the pack pins the commit it read');

  // -----------------------------------------------------------------------
  // 1. six calls, six edges, every one of them imperative.
  //
  // Split by RULE, because since RM47 this tree has a frontend too: the
  // gateway's AngularJS pages are read with no flag and their `$http` calls are
  // CALLS_HTTP edges as well. Those are asserted below on their own.
  // -----------------------------------------------------------------------
  const allHttp = graph.edges.filter((e) => e.type === 'CALLS_HTTP');
  const http = allHttp.filter((e) => e.evidence?.rule === 'http-client-call');
  assert.equal(http.length, 6, `expected the six imperative calls, got ${http.map(shortFrom).join(', ')}`);
  const stats = packJson.meta.laneStats;
  assert.equal(stats.httpCallsDeclarative, 0, 'nothing in this tree is a @FeignClient or an @HttpExchange');
  assert.equal(stats.httpCallsImperative, 6);
  assert.equal(stats.httpCallsResolved, 6, 'every one of the six names a route another service in this tree serves');
  assert.equal(stats.httpCallsUnresolved, 0);
  assert.equal(stats.httpCallsUrlUnreadable, 0);

  // -----------------------------------------------------------------------
  // 2. the edges themselves, by hand from the source above.
  // -----------------------------------------------------------------------
  assert.deepEqual(
    http.map((e) => [shortFrom(e), e.to.slice('endpoint:'.length), e.grade]).sort(),
    [
      ['api.application.CustomersServiceClient#getOwner', 'GET /owners/{ownerId}', 'SOUND_SET'],
      ['api.application.VisitsServiceClient#getVisitsForPets', 'GET /pets/visits', 'SOUND_SET'],
      ['genai.AIDataProvider#addOwnerToPetclinic', 'POST /owners', 'SOUND_SET'],
      ['genai.AIDataProvider#addPetToOwner', 'POST /owners/{ownerId}/pets', 'SOUND_SET'],
      ['genai.AIDataProvider#getAllOwners', 'GET /owners', 'SOUND_SET'],
      ['genai.VectorStoreController#loadVetDataToVectorStoreOnStartup', 'GET /vets', 'SOUND_SET'],
    ],
    'SOUND_SET and never higher: which deployable answers a service name is not knowable from source',
  );

  // The evidence says how much of each url was really read. The customers call
  // writes its host as a literal; the other two clients build the url from a
  // base this lane cannot resolve, and the service name is therefore NOT
  // claimed rather than guessed from the class name.
  const byCaller = new Map(http.map((e) => [shortFrom(e), e]));
  const customers = byCaller.get('api.application.CustomersServiceClient#getOwner');
  assert.equal(customers.evidence.rule, 'http-client-call');
  assert.equal(customers.evidence.client, 'webclient');
  assert.equal(customers.evidence.service, 'customers-service');
  assert.equal(customers.evidence.serviceLiteral, true);
  assert.equal(customers.evidence.url.kind, 'template');
  assert.equal(customers.evidence.match, 'exact');

  const visits = byCaller.get('api.application.VisitsServiceClient#getVisitsForPets');
  assert.equal(visits.evidence.url.kind, 'concat');
  assert.equal(visits.evidence.url.base, 'hostname', 'the base is named, not resolved');
  assert.equal(visits.evidence.service, null);
  assert.equal(visits.evidence.serviceLiteral, false);
  assert.equal(visits.evidence.query, 'petId={petId}', 'the query rides beside the path, never in it');

  const vets = byCaller.get('genai.VectorStoreController#loadVetDataToVectorStoreOnStartup');
  assert.equal(vets.evidence.url.written, 'vetsHostname + "vets"');
  assert.equal(vets.evidence.url.template, '/vets');

  // The RestClient call whose url interpolates the owner id: a hole in the call
  // path met a hole in the route template.
  const addPet = byCaller.get('genai.AIDataProvider#addPetToOwner');
  assert.equal(addPet.evidence.client, 'restclient');
  assert.equal(addPet.evidence.url.template, '/owners/{*}/pets');
  assert.equal(addPet.evidence.match, 'template');

  // -----------------------------------------------------------------------
  // 3. the point of the edge: the gateway's own route now reaches the tables
  //    the OTHER services own, through the hop and not around it.
  //    api-gateway/…/boundary/web/ApiGatewayController.java:54 is
  //    @GetMapping("owners/{ownerId}") under @RequestMapping("/api/gateway").
  // -----------------------------------------------------------------------
  const ctx = {
    graph,
    basis: { project: 'petclinic-ms', buildDigest: packJson.digest, builtAt: null, freshness: { verdict: 'unknown' } },
    trust: computeTrust({}),
    limits: [],
    pack: {
      project: 'petclinic-ms', digest: packJson.digest, lanes: packJson.meta.lanes,
      axes: packJson.meta.axes, laneStats: packJson.meta.laneStats,
    },
  };
  const flow = callTool('flow', { endpoint: 'GET /api/gateway/owners/{ownerId}' }, ctx).answer;
  assert.deepEqual(
    flow.tables.map((x) => [x.table, x.grade, x.viaHttp === true]).sort(),
    [['owners', 'SOUND_SET', true], ['visits', 'SOUND_SET', true]],
    'the gateway route reaches customers-service and visits-service data over the HTTP hop',
  );
  // …and the two clients are on the path, one hop from the controller.
  const services = new Map(flow.services.map((s) => [s.short, s.hops]));
  assert.equal(services.get('CustomersServiceClient#getOwner'), 1);
  assert.equal(services.get('VisitsServiceClient#getVisitsForPets'), 1);
  // The route the request passes THROUGH is served here, so it is not marked as
  // one this pack only calls.
  assert.equal(graph.nodes.get('endpoint:GET /owners/{ownerId}').outbound, undefined);

  // -----------------------------------------------------------------------
  // 4. THE FRONTEND (RM47). The gateway ships AngularJS as `<script>` tags
  //    under `src/main/resources/static/scripts` with no package.json
  //    anywhere, so nothing here passes a flag: discovery calls that directory
  //    a web root because it sits under `static`, `cascade init` wrote it into
  //    the profile, and this run read it.
  // -----------------------------------------------------------------------
  const web = allHttp.filter((e) => e.evidence?.rule === 'web-http-call');
  const shortWeb = (e) => e.from.slice('symbol:'.length).split('static/scripts/')[1];
  assert.deepEqual(
    web.map((e) => [shortWeb(e), e.to.slice('endpoint:'.length), e.grade]).sort(),
    [
      ['genai/chat.js#sendMessage', 'POST /chatclient', 'SOUND_SET'],
      ['owner-details/owner-details.controller.js#(module)', 'GET /api/gateway/owners/{ownerId}', 'SOUND_SET'],
      ['owner-form/owner-form.controller.js#(module)', 'GET /owners/{ownerId}', 'SOUND_SET'],
      ['owner-form/owner-form.controller.js#(module)', 'POST /owners', 'SOUND_SET'],
      ['owner-form/owner-form.controller.js#(module)', 'PUT /owners/{ownerId}', 'SOUND_SET'],
      ['owner-list/owner-list.controller.js#(module)', 'GET /owners', 'SOUND_SET'],
      ['pet-form/pet-form.controller.js#(module)', 'GET /owners/*/pets/{petId}', 'SOUND_SET'],
      ['pet-form/pet-form.controller.js#(module)', 'GET /owners/{ownerId}', 'SOUND_SET'],
      ['pet-form/pet-form.controller.js#(module)', 'GET /petTypes', 'SOUND_SET'],
      ['pet-form/pet-form.controller.js#(module)', 'POST /owners/{ownerId}/pets', 'SOUND_SET'],
      ['pet-form/pet-form.controller.js#(module)', 'PUT /owners/*/pets/{petId}', 'SOUND_SET'],
      ['vet-list/vet-list.controller.js#(module)', 'GET /vets', 'SOUND_SET'],
      ['visits/visits.controller.js#(module)', 'GET /owners/*/pets/{petId}/visits', 'SOUND_SET'],
      ['visits/visits.controller.js#(module)', 'POST /owners/*/pets/{petId}/visits', 'SOUND_SET'],
    ],
    'every `$http` call the pages make, with the gateway route table applied to its path',
  );
  // The `$http` a controller is handed is a client because the pack says so and
  // because the function sits inside `.controller(…)` — nothing in the file
  // binds that name.
  const ownersCall = web.find((e) => e.to === 'endpoint:GET /owners');
  assert.equal(ownersCall.evidence.sink.kind, 'injected');
  assert.equal(ownersCall.evidence.sink.module, '$http');
  assert.equal(ownersCall.evidence.url.written, 'api/customer/owners',
    'the path is relative and carries the gateway prefix, exactly as the source writes it');
  assert.equal(ownersCall.evidence.prefix.from, 'declared');
  assert.equal(ownersCall.evidence.service, 'customers-service');

  // NOT ONE ROUTE DECLARATION AMONG THEM. `$stateProvider.state('owners', {url:
  // '/owners'})` used to come out as an HTTP call to `/owners`.
  for (const e of web) {
    assert.ok(!e.from.endsWith('.js#(module)') || !/\/(app|owner-list|vet-list|visits|owner-form|pet-form|owner-details)\.js#/.test(e.from),
      `${e.from} is a router declaration file, not a caller`);
  }

  // The screens, and the chain of NAMES each one attached by.
  const screens = graph.nodes.values().toArray?.() ?? [...graph.nodes.values()];
  const screenPaths = screens.filter((n) => n.kind === 'screen').map((n) => n.path).sort();
  assert.deepEqual(screenPaths, [
    '/owners', '/owners/:ownerId/edit', '/owners/:ownerId/new-pet',
    '/owners/:ownerId/pets/:petId', '/owners/:ownerId/pets/:petId/visits',
    '/owners/details/:ownerId', '/owners/new', '/vets', '/welcome',
  ], 'nine screens: ten `.state(…)` links, of which `app` is abstract and mounts nothing');
  const renders = graph.edges.filter((e) => e.type === 'RENDERS');
  assert.deepEqual(
    renders.filter((e) => e.from === 'screen:/owners').map((e) => [e.grade, e.evidence.rule, e.evidence.names.join(' > ')]),
    [['EXACT', 'angular-controller', 'owner-list > ownerList > OwnerListController']],
    'the tag in the state template, the component registered under that name, and the controller it names',
  );
  // `<layout-welcome>` is registered in a loop over a computed name, so no
  // source line states it. No edge, and the name is reported rather than
  // silently dropped.
  assert.deepEqual(renders.filter((e) => e.from === 'screen:/welcome'), []);
  const screenStats = packJson.meta.laneStats.web.screens;
  assert.equal(screenStats.componentUnresolved, 1);
  assert.deepEqual(screenStats.unresolvedNames, [{ name: 'component layoutWelcome', count: 1 }]);

  // The whole sentence, end to end: a screen in the gateway to a column a
  // service owns, with the HTTP hop in the middle.
  const screenFlow = callTool('flow', { screen: '/owners' }, ctx).answer;
  assert.deepEqual(screenFlow.tables.map((x) => [x.table, x.grade, x.viaHttp === true]), [['owners', 'SOUND_SET', true]]);
  const back = callTool('screen_impact', { column: 'owners.first_name' }, ctx).answer;
  assert.ok(back.screens.some((s) => s.screen === '/owners'),
    `the column names the screen: ${back.screens.map((s) => s.screen).join(', ')}`);
});
