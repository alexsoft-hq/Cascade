import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Graph } from '../src/core/graph.mjs';
import { discover } from '../src/core/discover.mjs';
import { serverPortsOf } from '../src/core/server_ports.mjs';
import {
  BLOCKS_DIGESTED_WHEN_SET, PROFILE_KEY_CONSUMERS, digestedProfile, normalizeProfile, validateProfile,
} from '../src/core/profile.mjs';
import { declareAxes } from '../src/core/lanes.mjs';
import { axisRemedies, REMEDY_EXAMPLES } from '../src/core/remedies.mjs';
import { addWebFacts, webEndpointId } from '../src/adapters/web_bridge.mjs';

// THE PORT A PERSON STATES (RM67, after review 4). A call to this machine on a
// port no file of the tree states is HEURISTIC while an application's port
// rests on Spring Boot's default or is not known (review 4, W-7). The profile
// key `servers` is how a person says what the source does not: the port an
// application listens on, by the directory that holds it. A declared port is a
// stated one, so a call to it is no longer a guess; a declaration that names
// no application this run read is not applied, and is said.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'cascade.mjs');
const OPENAPI_FIXTURE = path.join(ROOT, 'test', 'fixtures', 'openapi', 'web-routes.yaml');

function tmpDir(t, prefix) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeTree(root, files) {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
}

/** A tree written to a temporary directory, discovered, and its ports read with `servers` declared. */
function portsOfTree(t, files, servers) {
  const root = tmpDir(t, 'cascade-servers-');
  writeTree(root, files);
  const io = {
    readDir: (dir) => fs.readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, isDir: e.isDirectory(), isFile: e.isFile() })),
    readFile: (p) => fs.readFileSync(p, 'utf8'),
    gitHead: () => null,
  };
  return serverPortsOf(discover(root, io).serverPorts, servers);
}

/** The one edge a fetch of `address` draws, with these ports, and the lane's stats. */
function landing(address, ports) {
  const u = new URL(address);
  const g = new Graph();
  const id = webEndpointId('GET', u.pathname);
  g.addNode({ id, path: u.pathname, httpMethod: 'GET', handler: 'x.C#m' });
  g.addEdge({ from: id, to: 'symbol:x.C#m', type: 'HANDLES', grade: 'EXACT' });
  const stats = addWebFacts(g, [
    { kind: 'file', file: 'src/a.js', line: 1, lang: 'js', recoveredErrors: 0 },
    { kind: 'function', file: 'src/a.js', line: 1, name: 'go', endLine: 1, exported: 'named', async: false, params: 0, returns: null },
    {
      kind: 'call', file: 'src/a.js', line: 1, enclosing: 'go', callee: { shape: 'ident', root: 'fetch', path: [], name: 'fetch' },
      binding: { kind: 'global', name: 'fetch' }, args: [], method: null, platformSink: 'fetch',
      url: {
        arg: { kind: 'string', value: address },
        resolved: [{ template: u.pathname, dynamicParts: 0, via: 'literal' }],
        absolute: { host: u.host, path: u.pathname },
      },
    },
  ], { serverPorts: ports });
  return { e: g.edges.find((x) => x.type === 'CALLS_HTTP'), stats };
}

const ADMIN_DEFAULT = { 'admin/src/main/resources/application.yml': 'spring:\n  application:\n    name: admin\n' };

// ---------------------------------------------------------------------------
// the profile key
// ---------------------------------------------------------------------------

test('servers: a map from an application\'s directory to the port it listens on, validated where the profile is read', () => {
  const ok = { servers: { 'mall-admin': { port: 8080 }, '.': { port: 9090, from: 'the deployment runbook' } } };
  assert.doesNotThrow(() => validateProfile(normalizeProfile(ok)));
  for (const [bad, why] of [
    [{ servers: [] }, /profile\.servers must be an object/],
    [{ servers: { admin: 8080 } }, /profile\.servers\["admin"\] must be an object \{port, from\}/],
    [{ servers: { admin: { port: 0 } } }, /\.port must be a whole number from 1 to 65535/],
    [{ servers: { admin: { port: '8080' } } }, /\.port must be a whole number from 1 to 65535/],
    [{ servers: { admin: { port: 8080, host: 'x' } } }, /has the key "host"/],
    [{ servers: { '${APP}': { port: 8080 } } }, /names the directory that holds the application/],
    [{ servers: { '': { port: 8080 } } }, /names the directory that holds the application/],
    [{ servers: { '/abs/admin': { port: 8080 } } }, /names the directory that holds the application/],
    // RM67-F5: this key names an application directory the SAME way discovery does,
    // relative to --root, never to the manifest directory (.cascade/) the profile
    // itself sits in, unlike every openapi/catalog/webRoots path in this file.
    [{ servers: { '${APP}': { port: 8080 } } }, /relative to the analysis root, not the manifest directory/],
  ]) {
    assert.throws(() => validateProfile(normalizeProfile(bad)), (e) => e.name === 'ProfileError' && why.test(e.message), JSON.stringify(bad));
  }
});

test('servers: at its default the profile digest is what it was before the key existed, and it is a consumed key', () => {
  assert.ok(BLOCKS_DIGESTED_WHEN_SET.includes('servers'));
  assert.equal(Object.hasOwn(digestedProfile(normalizeProfile({})), 'servers'), false);
  assert.deepEqual(digestedProfile(normalizeProfile({ servers: { a: { port: 1 } } })).servers, { a: { port: 1 } });
  assert.equal(PROFILE_KEY_CONSUMERS.servers.status, 'consumed');
  // RM67-F5: the note used to call this key "manifest-relative", like openapi/catalog/
  // webRoots, but server_ports.mjs compares it with root-relative discovery paths and
  // never resolves it against the manifest directory at all.
  assert.match(PROFILE_KEY_CONSUMERS.servers.note, /root-relative, not manifest-relative/);
});

// ---------------------------------------------------------------------------
// what a declared port does
// ---------------------------------------------------------------------------

test('a declared port is a stated one: the call to it is settled, and without the key it stays a default guess', (t) => {
  const assumed = portsOfTree(t, ADMIN_DEFAULT, {});
  assert.deepEqual([assumed.known, assumed.defaulted, assumed.stated, assumed.assumed], [true, true, [], ['admin']]);
  assert.equal(landing('http://localhost:8080/things', assumed).e.grade, 'HEURISTIC');
  // Declared by the directory that holds the application, or by its resources directory.
  for (const key of ['admin', 'admin/src/main/resources']) {
    const declared = portsOfTree(t, ADMIN_DEFAULT, { [key]: { port: 8080 } });
    assert.deepEqual([declared.known, declared.defaulted, declared.stated, declared.assumed], [true, false, [8080], []], key);
    const { e } = landing('http://localhost:8080/things', declared);
    assert.deepEqual([e.grade, e.evidence.url.guess], ['SOUND_SET', undefined], key);
    // Another port is another service's, with the declaration named, as written, as where the port came from.
    const away = landing('http://localhost:9090/things', declared).e;
    assert.equal(away.grade, 'UNRESOLVED');
    assert.ok(away.evidence.away.reason.includes(`servers[${JSON.stringify(key)}] in the profile`), away.evidence.away.reason);
  }
});

test('a declared port settles an application whose own port is not known, and one the tree states differently is used and said', (t) => {
  const placeholder = { 'admin/src/main/resources/application.yml': 'server:\n  port: ${PORT:8080}\n' };
  assert.equal(portsOfTree(t, placeholder, {}).known, false);
  const settled = portsOfTree(t, placeholder, { admin: { port: 7000 } });
  assert.deepEqual([settled.known, settled.stated], [true, [7000]]);
  const differs = portsOfTree(t, { 'admin/src/main/resources/application.yml': 'server:\n  port: 8081\n' }, { admin: { port: 7000 } });
  assert.deepEqual([differs.ports, differs.stated], [[7000], [7000]]);
  assert.deepEqual(differs.declared, [{ key: 'admin', app: 'admin/src/main/resources', port: 7000, tree: [8081] }]);
});

test('a declaration that names no application this run read is not applied, and is said', (t) => {
  const ports = portsOfTree(t, ADMIN_DEFAULT, { admn: { port: 8080 } });
  assert.deepEqual([ports.defaulted, ports.stated, ports.unused], [true, [], ['admn']]);
  const { e, stats } = landing('http://localhost:8080/things', ports);
  assert.equal(e.grade, 'HEURISTIC');
  assert.deepEqual(stats.ports.unused, ['admn']);
});

// ---------------------------------------------------------------------------
// the remedy
// ---------------------------------------------------------------------------

/** The web axis a run whose only guess is the port on this machine declares. */
function portOnlyWeb(assumed) {
  return {
    files: 3, calls: { withUrl: 4, untraced: 0 }, resolved: { SOUND_SET: 0, HEURISTIC: 4 },
    prefix: { front: { instances: [{ id: 'front/src/http.js#client', from: 'derived', guess: 'port-default' }] } },
    ports: { known: true, ports: [8080], stated: [], defaulted: true, assumed, unused: [] },
  };
}

test('the web axis names the key, with the application it would settle, and so does its remedy', () => {
  const axes = declareAxes({ web: portOnlyWeb(['mall-admin']) });
  assert.equal(axes.web.status, 'degraded');
  assert.match(axes.web.reason, /declare servers \{"mall-admin": \{"port": 8080\}\}/);
  assert.deepEqual(axes.web.causes, ['port-default']);
  assert.deepEqual(axisRemedies(axes).web, { action: 'declare', key: 'servers', example: REMEDY_EXAMPLES.servers });
  // Degraded for another reason too: the key would not make it whole, so the engine names no single fix.
  const mixed = portOnlyWeb(['mall-admin']);
  mixed.prefix.front.instances.push({ id: 'front/src/other.js#o', from: 'auto' });
  assert.equal(axisRemedies(declareAxes({ web: mixed })).web, null);
});

// ---------------------------------------------------------------------------
// through `cascade analyze`
// ---------------------------------------------------------------------------

/** A backend application that states no port, a frontend on localhost:8080, and the routes a document declares. */
function projectTree(t) {
  const base = tmpDir(t, 'cascade-servers-cli-');
  const dir = path.join(base, 'proj');
  writeTree(dir, {
    'admin/src/main/resources/application.yml': 'spring:\n  application:\n    name: admin\n',
    'front/package.json': '{"name":"front","dependencies":{"axios":"1"}}\n',
    'front/src/http.js': "import axios from 'axios';\nconst client = axios.create({ baseURL: 'http://localhost:8080' });\nexport default client;\n",
    'front/src/api.js': "import client from './http';\nexport function listThings() { return client.get('/things/list'); }\n",
  });
  fs.copyFileSync(OPENAPI_FIXTURE, path.join(dir, 'api.yaml'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.email=dev@example.com', '-c', 'user.name=dev', 'commit', '-qm', 'init');
  return { base, dir };
}

function analyzed(t, { base, dir }, profile) {
  const out = path.join(base, `pack-${Object.keys(profile).length}`);
  const profileFile = path.join(base, `profile-${Object.keys(profile).length}.json`);
  fs.writeFileSync(profileFile, JSON.stringify(profile));
  execFileSync(process.execPath, [CLI, 'analyze', '--root', dir, '--web-src', path.join(dir, 'front', 'src'),
    '--openapi', path.join(dir, 'api.yaml'), '--no-java', '--no-mappers', '--profile', profileFile, '--out', out], {
    env: { ...process.env, CASCADE_HOME: path.join(base, 'home') }, cwd: base, stdio: ['ignore', 'ignore', 'pipe'],
  });
  const pack = JSON.parse(fs.readFileSync(path.join(out, 'pack.json'), 'utf8'));
  return { pack, edge: pack.edges.find((e) => e.type === 'CALLS_HTTP' && e.from.endsWith('#listThings')) };
}

test('cascade analyze reads servers from the profile: the call on localhost:8080 is SOUND_SET only with it', (t) => {
  const tree = projectTree(t);
  const without = analyzed(t, tree, {});
  assert.deepEqual([without.edge.grade, without.edge.evidence.prefix.guess], ['HEURISTIC', 'port-default']);
  assert.match(without.pack.meta.axes.web.reason, /declare servers \{"admin": \{"port": 8080\}\}/);
  const declared = analyzed(t, tree, { servers: { admin: { port: 8080 } } });
  assert.equal(declared.edge.grade, 'SOUND_SET');
  assert.deepEqual(declared.pack.meta.laneStats.web.ports.stated, [8080]);
  assert.equal(declared.pack.meta.axes.web.status, 'shipped', declared.pack.meta.axes.web.reason);
});
