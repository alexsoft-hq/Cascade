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
import { addWebFacts, webEndpointId } from '../src/adapters/web_bridge.mjs';

// The web lane and port defects the fourth review reproduced (RM67, review 4,
// "web and ports"), on the reviewer's own fixtures (test/fixtures/web-review4:
// m2, m3, m4, b2, s2, s4, s5) and one of this round's (s6), run through the
// worker that is spawned and then the bridge, as `cascade analyze` does. The
// port cases are trees written to a temporary directory and discovered.
//
// What they pin is one rule each way:
//   a wrapper step is SETTLED only in shapes the code positively recognizes as
//     reading the object it hands on; any other use of it (a container, a
//     pattern, a method call on it, a copy through `||`) leaves the key unsettled
//   the method and the base URL are the library's default only when nothing on
//     the way may have written them; a write the code does not settle leaves
//     them unknown, never GET
//   a port that rests on Spring Boot's default, or that no application states,
//     is not a fact a SOUND_SET edge may rest on

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = path.join(ROOT, 'adapters', 'web', 'webfacts.mjs');
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'web-review4');

function factsOf(dir) {
  return execFileSync(process.execPath, [WORKER, '--root', dir, path.join(dir, 'src')], { maxBuffer: 1 << 26 })
    .toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const VERBS = ['GET', 'POST', 'DELETE', 'PUT', 'PATCH'];
function run(name, paths, routes = null) {
  const g = new Graph();
  for (const [method, p] of routes ?? VERBS.flatMap((m) => paths.map((x) => [m, x]))) {
    const id = webEndpointId(method, p);
    g.addNode({ id, path: p, httpMethod: method, handler: 'com.x.C#m' });
    g.addEdge({ from: id, to: 'symbol:com.x.C#m', type: 'HANDLES', grade: 'EXACT' });
  }
  const stats = addWebFacts(g, factsOf(path.join(FIXTURES, name)));
  return { g, stats };
}
const http = (g, fn) => g.edges.filter((e) => e.type === 'CALLS_HTTP' && e.from.endsWith(`#${fn}`));
const said = (edges) => edges.map((e) => [e.to, e.grade]).sort();
const ITEMS = (m) => webEndpointId(m, '/items');
/** Every edge HEURISTIC, and one of them the method the request really sends. */
function unknownButReaches(edges, method, fn) {
  assert.ok(edges.length > 0, `${fn}: no edge`);
  assert.ok(edges.every((e) => e.grade === 'HEURISTIC'), `${fn}: ${JSON.stringify(said(edges))}`);
  assert.ok(edges.some((e) => e.to === ITEMS(method)), `${fn}: ${JSON.stringify(said(edges))}`);
}

// ---------------------------------------------------------------------------
// W-1, W-5: a method a step may have written is not the library's default
// ---------------------------------------------------------------------------

test('method_key_written_by_step_is_not_library_default', () => {
  const { g } = run('m3', ['/items']);
  // d1 cfg.method = verb (DELETE); d4 if (x) cfg.method = 'POST'; d5 o.method = c ? 'POST' : 'PUT';
  // d7 a write in a callback; d10 a destructuring assignment; d12 Object.assign({}, o, {method});
  // d13 {...o, ...{method}}; d3 cfg[k] = 'POST'; d9 Reflect.set; d11 through a `let`.
  for (const [fn, sent] of [['d1', 'DELETE'], ['d4', 'POST'], ['d5', 'PUT'], ['d7', 'POST'], ['d10', 'POST'],
    ['d12', 'DELETE'], ['d13', 'PUT'], ['d3', 'POST'], ['d9', 'PATCH'], ['d11', 'POST']]) {
    unknownButReaches(http(g, fn), sent, fn);
    assert.ok(http(g, fn).every((e) => e.evidence.method.value === null), `${fn}: ${JSON.stringify(http(g, fn)[0].evidence.method)}`);
    assert.equal(typeof http(g, fn)[0].evidence.sink.unsettled?.reason, 'string', `${fn}: the edge says why`);
  }
  // A write the code does not settle is named with its step and its key.
  assert.deepEqual(['why', 'key', 'hop'].map((k) => http(g, 'd1')[0].evidence.sink.unsettled[k]), ['written', 'method', 'src/wrappers.js#w1']);
  // A write that always runs and puts a string there is still read (review 3, R1).
  assert.deepEqual(said(http(g, 'd8')), [[ITEMS('POST'), 'SOUND_SET']]);
  const { g: g2 } = run('m2', ['/items', '/api/items']);
  // c8 a conditional write after the copy; c14 written twice (PUT is what is sent).
  unknownButReaches(http(g2, 'c8'), 'POST', 'c8');
  unknownButReaches(http(g2, 'c14'), 'PUT', 'c14');
});

test('unsettled_method_draws_every_method', () => {
  // Object.assign(cfg, extra) with extra.method POST; mutate(cfg) sets DELETE.
  const { g } = run('m3', ['/items']);
  unknownButReaches(http(g, 'd2'), 'POST', 'd2');
  unknownButReaches(http(g, 'd6'), 'DELETE', 'd6');
});

test('spread_of_local_defaults_carrying_method_is_not_library_default', () => {
  // axios({ ...defaults, ...o }) with const defaults = { method: 'PUT' }.
  const { g } = run('m2', ['/items', '/api/items']);
  unknownButReaches(http(g, 'c9'), 'PUT', 'c9');
});

test('method_handed_as_parameter_is_followed', () => {
  // W-11: req('/items', 'DELETE') -> axios({ url, method: m }); req2({ url, method: 'PUT' }) -> axios({ method: o.method }).
  const { g } = run('m4', ['/items']);
  assert.deepEqual(said(http(g, 'k1')), [[ITEMS('DELETE'), 'SOUND_SET']]);
  assert.deepEqual(said(http(g, 'k2')), [[ITEMS('PUT'), 'SOUND_SET']]);
  // Nothing handed at that parameter past the first step is not known to be nothing: not the library's GET.
  assert.ok(http(g, 'k3').every((e) => e.grade === 'HEURISTIC' && e.evidence.method.value === null));
  // A verb written inside the chain and handed on is not tracked, so it stays unknown (review 3, t3).
  const { g: g3 } = run('m3', ['/items']);
  assert.ok(http(g3, 'd1').every((e) => e.evidence.method.value === null));
});

test('the url handed to another call is text; the options handed to one are not settled', () => {
  const { g } = run('m5', ['/items']);
  assert.deepEqual(said(http(g, 'k4')), [[ITEMS('PUT'), 'SOUND_SET']]);
  const k5 = http(g, 'k5');
  assert.ok(k5.some((e) => e.to === ITEMS('PUT')) && k5.every((e) => e.grade === 'HEURISTIC' && e.evidence.method.value === null), JSON.stringify(said(k5)));
  assert.deepEqual([k5[0].evidence.sink.unsettled.why, k5[0].evidence.sink.unsettled.key], ['handed', 'method']);
});

// ---------------------------------------------------------------------------
// W-1 (R3): a base URL a step may have written is not the instance's
// ---------------------------------------------------------------------------

test('base_url_key_written_by_step_is_not_instance_base', () => {
  const { g } = run('b2', null, [['GET', '/items'], ['GET', '/v2/items'], ['GET', '/v3/items']]);
  // b3 if (o.alt) cfg.baseURL = '/v2'; b4 cfg.baseURL = b; b5 written twice.
  for (const fn of ['b3', 'b4', 'b5']) {
    const e = http(g, fn);
    assert.ok(e.length > 0 && e.every((x) => x.grade === 'HEURISTIC'), `${fn}: ${JSON.stringify(said(e))}`);
    // The edge names the step and the key it wrote.
    const u = e[0].evidence.sink.unsettled;
    assert.deepEqual([u?.why, u?.key, u?.hop], ['written', 'baseURL', `src/hops.js#p${fn.slice(1)}`], fn);
  }
  // Written once, always, as a path: that is the base the request goes under.
  assert.deepEqual(said(http(g, 'b6')), [[webEndpointId('GET', '/v2/items'), 'SOUND_SET']]);
});

// ---------------------------------------------------------------------------
// W-2: a copy that writes the URL back from the parameter hands it on
// ---------------------------------------------------------------------------

test('copy_that_rewrites_url_from_the_parameter_hands_it_on', () => {
  const { g, stats } = run('s4', ['/items']);
  // r5: const cfg = { ...option, url: option.url }: the same value, so the hop is settled.
  assert.deepEqual(said(http(g, 'f5')), [[ITEMS('GET'), 'SOUND_SET']]);
  // r9: url: `${option.url}` is a value built from it: reached, not settled.
  const f9 = http(g, 'f9');
  assert.ok(f9.some((e) => e.to === ITEMS('GET')) && f9.every((e) => e.grade === 'HEURISTIC'), JSON.stringify(said(f9)));
  assert.equal(f9[0].evidence.sink.unsettled.key, 'url');
  assert.equal(stats.calls.urlNotHandedOn, 0, JSON.stringify(stats.calls));
});

// ---------------------------------------------------------------------------
// W-3: settled is decided by default-deny
// ---------------------------------------------------------------------------

test('settled_hop_destructuring_or_container_write_is_not_settled', () => {
  const { g } = run('s2', ['/items', '/other']);
  // Every hop of s2 writes '/other' over the URL somewhere: none may be SOUND_SET on /items.
  for (let i = 1; i <= 17; i += 1) {
    const fn = `a${i}`;
    assert.ok(!http(g, fn).some((e) => e.grade === 'SOUND_SET' && e.to.endsWith(' /items')), `${fn}: ${JSON.stringify(said(http(g, fn)))}`);
  }
  // a16: the copy writes url back from the parameter, then `+=` over it: reached, unsettled.
  assert.ok(http(g, 'a16').length > 0 && http(g, 'a16').every((e) => e.grade === 'HEURISTIC'));
});

test('settled_hop_is_settled_only_in_shapes_that_read_the_object', () => {
  const { g } = run('s6', ['/items', '/other']);
  // A container, a store on another object, a pattern, a for-of target, a method call on
  // the object, a copy through `? :` or `||`, an array handed to a call, a tagged template.
  for (const fn of ['x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7', 'x8', 'x9', 'x10', 'x11']) {
    const e = http(g, fn);
    assert.ok(e.length > 0 && e.every((x) => x.grade === 'HEURISTIC'), `${fn}: ${JSON.stringify(said(e))}`);
    assert.ok(['written', 'handed'].includes(e[0].evidence.sink.unsettled?.why), `${fn}: ${JSON.stringify(e[0].evidence.sink)}`);
  }
  // A test on a key, a key read into a call, Object.keys, a spread copy, a destructuring
  // declaration: reads, and the hop stays settled.
  for (const fn of ['y1', 'y2', 'y3']) assert.deepEqual(said(http(g, fn)), [[ITEMS('GET'), 'SOUND_SET']], fn);
});

test('url_kept_in_a_module_variable_or_a_global_is_not_said_dropped', () => {
  // `last = option; axios(last)` with a module `let`, and `window.lastCfg = option; axios(window.lastCfg)`:
  // the request is the caller's, through a place the syntax does not settle.
  const { g, stats } = run('g1', ['/items']);
  for (const fn of ['a', 'b']) {
    const e = http(g, fn);
    assert.ok(e.some((x) => x.to === ITEMS('GET')) && e.every((x) => x.grade === 'HEURISTIC'), `${fn}: ${JSON.stringify(said(e))}`);
  }
  assert.equal(stats.calls.urlNotHandedOn, 0);
  assert.deepEqual(stats.calls.unreadHopBy, { reassigned: 1, unbound: 1 });
});

// ---------------------------------------------------------------------------
// W-6: an argument whose URL was never read is not "dropped by the wrapper"
// ---------------------------------------------------------------------------

test('config_object_in_a_local_is_not_said_dropped_by_the_wrapper', () => {
  const { stats } = run('s5', ['/items']);
  assert.equal(stats.calls.urlNotHandedOn, 0, JSON.stringify(stats.calls));
  // g1..g3 are counted where an unread URL is counted, and g4 is placed: nothing vanishes.
  assert.equal(stats.calls.withUrl, 4, JSON.stringify(stats.calls));
  assert.equal(stats.unresolved.byReason.parameter, 3, JSON.stringify(stats.unresolved));
});

// ---------------------------------------------------------------------------
// W-7 .. W-10: ports
// ---------------------------------------------------------------------------

/** A tree written to a temporary directory, discovered, and its ports read. */
function portsOfTree(t, files) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-ports-r4-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  const io = {
    readDir: (dir) => fs.readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, isDir: e.isDirectory(), isFile: e.isFile() })),
    readFile: (p) => fs.readFileSync(p, 'utf8'),
    gitHead: () => null,
  };
  return serverPortsOf(discover(root, io).serverPorts);
}

/** The one edge a fetch of `address` draws, with these ports. */
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
  return { e: g.edges.find((x) => x.type === 'CALLS_HTTP'), id, stats };
}

const YML_8081 = { 'src/main/resources/application.yml': 'server:\n  port: 8081\n' };

test('call_on_unstated_port_is_not_sound_set_when_port_rests_on_default', (t) => {
  const ports = portsOfTree(t, { 'src/main/resources/application.yml': 'spring:\n  application:\n    name: a\n' });
  assert.deepEqual([ports.known, ports.defaulted, ports.stated], [true, true, []]);
  // 9090 is not the default, and the default is only assumed: whose call it is is not settled.
  const { e, id } = landing('http://localhost:9090/things', ports);
  assert.deepEqual([e.to, e.grade, e.evidence.away], [id, 'HEURISTIC', undefined]);
  assert.equal(e.evidence.url.guess, 'port-default');
  // 8080 is this pack's only on the strength of that same default.
  assert.equal(landing('http://localhost:8080/things', ports).e.grade, 'HEURISTIC');
  // A port the configuration states is a fact: that call stays SOUND_SET.
  const stated = portsOfTree(t, YML_8081);
  assert.equal(landing('http://localhost:8081/things', stated).e.grade, 'SOUND_SET');
});

test('call_on_a_port_no_application_states_is_not_sound_set_when_one_port_is_not_known', (t) => {
  const ports = portsOfTree(t, {
    'a/src/main/resources/application.yml': 'server:\n  port: ${PORT:8080}\n',
    'b/src/main/resources/application.yml': 'server:\n  port: 8081\n',
  });
  assert.equal(ports.known, false);
  const { e, stats } = landing('http://localhost:9090/things', ports);
  assert.deepEqual([e.grade, e.evidence.away, e.evidence.url.guess], ['HEURISTIC', undefined, 'port-unknown']);
  assert.equal(stats.url.guessed['port-unknown'], 1);
  // The port the other application states is still read.
  assert.equal(landing('http://localhost:8081/things', ports).e.grade, 'SOUND_SET');
});

test('server_port_zero_is_not_a_known_port', (t) => {
  const ports = portsOfTree(t, { 'src/main/resources/application.properties': 'server.port=0\n' });
  assert.equal(ports.known, false, 'port 0 is one the application picks when it starts');
  assert.match(ports.why, /server\.port/);
  assert.equal(landing('http://localhost:8080/things', ports).e.evidence.away, undefined);
});

test('deployment_port_in_tree_is_read_or_port_unknown', (t) => {
  for (const [file, text] of [
    ['Dockerfile', 'FROM x\n# app params: -e PARAMS="--server.port=7070"\nENTRYPOINT ["java","-jar","app.jar","--server.port=9090"]\n'],
    ['docker-compose.yml', 'services:\n  app:\n    environment:\n      SERVER_PORT: 9090\n'],
  ]) {
    const ports = portsOfTree(t, { ...YML_8081, [file]: text });
    assert.deepEqual([ports.known, ports.ports], [true, [8081, 9090]], `${file}: ${ports.why}`);
    assert.equal(landing('http://localhost:9090/things', ports).e.grade, 'SOUND_SET', file);
    // A port neither the configuration nor the deployment states is still another service's.
    assert.equal(landing('http://localhost:7070/things', ports).e.grade, 'UNRESOLVED', file);
  }
  // A deployment that sets it from somewhere else makes it not known.
  const placeholder = portsOfTree(t, { ...YML_8081, 'docker-compose.yml': 'services:\n  app:\n    command: --server.port=${ADMIN_PORT}\n' });
  assert.equal(placeholder.known, false);
  assert.match(placeholder.why, /docker-compose\.yml:3/);
});

test('server_port_set_in_code_non_first_arg_or_constant_or_kotlin', (t) => {
  for (const [file, code] of [
    ['src/main/java/x/App.java', 'package x;\npublic class App { static final String K = "server.port"; public static void main(String[] a){ System.setProperty(K, "9090"); } }\n'],
    ['src/main/kotlin/x/App.kt', 'package x\nclass C : WebServerFactoryCustomizer<ConfigurableWebServerFactory> { override fun customize(f: ConfigurableWebServerFactory) { f.setPort(9090) } }\n'],
    ['src/main/java/x/App.java', 'package x;\npublic class App { public static void main(String[] a){ new SpringApplicationBuilder(App.class).properties(Map.of("spring.main.banner-mode","off","server.port","9090")).run(a); } }\n'],
  ]) {
    const ports = portsOfTree(t, { ...YML_8081, [file]: code });
    assert.equal(ports.known, false, file);
    assert.notEqual(landing('http://localhost:9090/things', ports).e.grade, 'UNRESOLVED', file);
  }
  // Reading the key is not setting it: the port stays the one the configuration states.
  const read = portsOfTree(t, {
    ...YML_8081,
    'src/main/java/x/App.java': 'package x;\nclass App { void f(Environment env) { String port = env.getProperty("server.port"); } }\n',
  });
  assert.deepEqual([read.known, read.ports], [true, [8081]], read.why);
});
