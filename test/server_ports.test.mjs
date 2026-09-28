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
  assert.equal(imported.external, true);
  const nacos = cfg('n/src/main/resources/bootstrap.yml', 'spring:\n  cloud:\n    nacos:\n      config:\n        server-addr: x\n');
  assert.equal(nacos.external, true);
  const server = cfg('cs/src/main/resources/application.yml', 'server.port: 8888\n');
  const all = serverPortsOf([imported, server]);
  assert.equal(all.known, false, 'the config server\'s own 8888 is not the port the other application listens on');
  assert.match(all.why, /takes the configuration from outside this tree/);
  // A classpath import is a file in the tree, and decides nothing.
  assert.equal(cfg('k/src/main/resources/application.yml', 'spring:\n  config:\n    import: classpath:extra.yml\n').external, false);
});

test('no Spring application read is not a port', () => {
  assert.deepEqual(serverPortsOf([]).known, false);
});
