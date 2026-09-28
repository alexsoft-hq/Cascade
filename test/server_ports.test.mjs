import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serverPortsOfFile, serverPortsOf, SERVER_PORT } from '../src/core/server_ports.mjs';

// WHICH PORT EACH SPRING APPLICATION LISTENS ON, read from its own
// configuration, and when that is not known. The web lane places a call on this
// machine by its port only when this answer is `known` (web_base_url.test.mjs).

const cfg = (path, text) => serverPortsOfFile({ path, text });

test('server.port is read from YAML and from properties, with the file and the line', () => {
  const yml = cfg('a/src/main/resources/application.yml', 'spring:\n  application:\n    name: a\nserver:\n  port: 8081\n');
  assert.equal(yml.app, 'a/src/main/resources');
  assert.deepEqual(yml.ports, [{ port: 8081, line: 5, conditional: false }]);
  const props = cfg('b/src/main/resources/application.properties', 'server.port= 8082\n');
  assert.deepEqual(props.ports.map((p) => p.port), [8082]);
  const all = serverPortsOf([yml, props]);
  assert.deepEqual([all.known, all.ports, all.files], [true, [8081, 8082], [
    'a/src/main/resources/application.yml', 'b/src/main/resources/application.properties',
  ]]);
});

test('a profile\'s port is one more way the application runs, and with none set in the base file Spring\'s default is too', () => {
  const base = cfg('s/src/main/resources/application.yaml', 'spring:\n  profiles:\n    active: local\n');
  const local = cfg('s/src/main/resources/application-local.yaml', 'server:\n  port: 48080\n');
  assert.equal(local.ports[0].conditional, true);
  const all = serverPortsOf([base, local]);
  assert.deepEqual(all.ports, [SERVER_PORT.defaultPort, 48080].sort((a, b) => a - b));
  assert.equal(all.defaulted, true);
  // Set in the base file, the default is not a port this application runs on.
  const set = serverPortsOf([cfg('s/src/main/resources/application.yml', 'server:\n  port: 8000\n'), local]);
  assert.deepEqual([set.ports, set.defaulted], [[8000, 48080], false]);
});

test('a port a deployment sets is not known, and one unknown application makes the pack\'s ports unknown', () => {
  const placeholder = cfg('p/src/main/resources/application.yml', 'server:\n  port: ${PORT:8080}\n');
  assert.deepEqual(placeholder.unreadable, [{ raw: '${PORT:8080}', line: 2 }]);
  const known = cfg('q/src/main/resources/application.yml', 'server:\n  port: 8081\n');
  const all = serverPortsOf([placeholder, known]);
  assert.equal(all.known, false);
  assert.match(all.why, /p\/src\/main\/resources: server\.port is not a number the tree states/);
  assert.deepEqual(all.ports, [], 'an unknown pack claims no port at all');
});

test('an application that takes its configuration from a config server or Nacos has no port this tree states', () => {
  const imported = cfg('c/src/main/resources/application.yml',
    'spring:\n  config:\n    import: optional:configserver:${CONFIG_SERVER_URL:http://localhost:8888/}\n');
  assert.equal(imported.external, 'spring.config.import');
  const nacos = cfg('n/src/main/resources/bootstrap.yml', 'spring:\n  cloud:\n    nacos:\n      config:\n        server-addr: x\n');
  assert.equal(nacos.external, 'spring.cloud.nacos');
  const server = cfg('cs/src/main/resources/application.yml', 'server.port: 8888\n');
  const all = serverPortsOf([imported, server]);
  assert.equal(all.known, false, 'the config server\'s own 8888 is not the port the other application listens on');
  assert.match(all.why, /brings in configuration this reader does not follow/);
  // A classpath import is a file in the tree, but this reader does not follow
  // it, so what it sets is not known either (review 2, item 11).
  assert.equal(Boolean(cfg('k/src/main/resources/application.yml', 'spring:\n  config:\n    import: classpath:extra.yml\n').external), true);
});

test('no Spring application read is not a port', () => {
  assert.deepEqual(serverPortsOf([]).known, false);
});

// ---------------------------------------------------------------------------
// Configuration the reader does not follow (review 2, item 11)
// ---------------------------------------------------------------------------

test('imported_server_port_prevents_false_outbound', async (t) => {
  // `spring.config.import=classpath:extra.properties`, and that file sets 9090.
  // The reader does not follow the import, so it does not know the port, and a
  // call to localhost:9090 is never "another service" on the strength of 8080.
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { discover } = await import('../src/core/discover.mjs');
  const { Graph } = await import('../src/core/graph.mjs');
  const { addWebFacts, webEndpointId } = await import('../src/adapters/web_bridge.mjs');
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-ports-import-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  write('src/main/resources/application.properties', 'spring.config.import=classpath:extra.properties\n');
  write('src/main/resources/extra.properties', 'server.port=9090\n');
  const io = {
    readDir: (dir) => fs.readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, isDir: e.isDirectory(), isFile: e.isFile() })),
    readFile: (p) => fs.readFileSync(p, 'utf8'),
    gitHead: () => null,
  };
  const ports = serverPortsOf(discover(root, io).serverPorts);
  assert.equal(ports.known, false);
  assert.match(ports.why, /spring\.config\.import/);
  const g = new Graph();
  const id = webEndpointId('GET', '/things');
  g.addNode({ id, path: '/things', httpMethod: 'GET', handler: 'x.C#m' });
  g.addEdge({ from: id, to: 'symbol:x.C#m', type: 'HANDLES', grade: 'EXACT' });
  addWebFacts(g, [
    { kind: 'file', file: 'src/a.js', line: 1, lang: 'js', recoveredErrors: 0 },
    { kind: 'function', file: 'src/a.js', line: 1, name: 'right', endLine: 1, exported: 'named', async: false, params: 0, returns: null },
    {
      kind: 'call', file: 'src/a.js', line: 1, enclosing: 'right', callee: { shape: 'ident', root: 'fetch', path: [], name: 'fetch' },
      binding: { kind: 'global', name: 'fetch' }, args: [], method: null, platformSink: 'fetch',
      url: {
        arg: { kind: 'string', value: 'http://localhost:9090/things' },
        resolved: [{ template: '/things', dynamicParts: 0, via: 'literal' }],
        absolute: { host: 'localhost:9090', path: '/things' },
      },
    },
  ], { serverPorts: ports });
  const e = g.edges.find((x) => x.type === 'CALLS_HTTP');
  assert.equal(e.to, id);
  assert.equal(e.grade, 'SOUND_SET');
  assert.equal(e.evidence.away, undefined);
});

test('a location, a name, a @PropertySource or a profile placeholder is configuration the reader does not follow', () => {
  for (const [file, text] of [
    ['a/src/main/resources/application.yml', 'spring:\n  config:\n    location: file:/etc/app/\nserver:\n  port: 8081\n'],
    ['a/src/main/resources/application.yml', 'spring:\n  config:\n    additional-location: optional:file:./conf/\n'],
    ['a/src/main/resources/application.properties', 'spring.config.name=service\n'],
    ['a/src/main/resources/application.yml', 'spring:\n  profiles:\n    active: ${APP_PROFILE:local}\n'],
    ['a/src/main/resources/application.yml', 'spring:\n  profiles:\n    group:\n      prod: ${EXTRA}\n'],
  ]) {
    assert.equal(serverPortsOf([cfg(file, text)]).known, false, text);
  }
  // Loaded in code, not in the configuration files.
  const code = serverPortsOf([
    cfg('a/src/main/resources/application.yml', 'server:\n  port: 8081\n'),
    { file: 'a/src/main/java/x/Config.java', app: 'a/src/main/resources', ports: [], unreadable: [], external: '@PropertySource' },
  ]);
  assert.equal(code.known, false);
  assert.match(code.why, /@PropertySource/);
});
