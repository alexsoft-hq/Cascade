// server_ports.mjs — which port each Spring application in the tree listens on.
//
// WHY. `http://localhost:8081/owners` and `http://localhost:8082/visits` are
// both this machine, and in a repository with more than one backend the PORT is
// what tells the two services apart. A frontend call on a port no application
// of this pack listens on is another service's call, and the web lane leaves it
// outbound with both ports named (src/adapters/web/base_url.mjs).
//
// WHAT IS READ, AS DATA. `server.port` in each application's own configuration
// (`application*.yml|yaml|properties`, `bootstrap*`), every profile included,
// because each profile is one way the same application runs. Where no document
// that applies with no profile sets it, the application also listens on Spring
// Boot's documented default (below). An APPLICATION is the resources directory
// its configuration sits in: two modules are two applications. A deployment
// file in the tree that starts it on another port is one more way it runs
// (src/core/server_ports_deploy.mjs).
//
// WHAT MAKES IT UNKNOWN, and then nothing is decided by port at all:
//   - a `server.port` that is a placeholder (`${PORT:8080}`), not a number, or
//     0 (a port the application picks when it starts): no file here states it
//   - an application that takes its configuration from outside the tree (a
//     config server, Nacos, Consul, ZooKeeper): its port is in that server
//   - no Spring application read at all
// An unknown application leaves the others' ports as read, and the pack's
// ports not KNOWN: a call on a port none of them states may be that
// application's (review 3, design 4).
//
// Pure: records in, one answer out. Discovery reads the files
// (src/core/discover.mjs); `cascade analyze` hands the answer to the web bridge.

import path from 'node:path';
import { springConfigEntries, conditionalDocuments, relaxedKey } from './springconfig.mjs';
import { portNumber, withDeployments } from './server_ports_deploy.mjs';

/** Spring Boot's own key, and the port it listens on when nothing sets it. */
export const SERVER_PORT = Object.freeze({
  key: 'server.port',
  defaultPort: 8080,
  source: 'Spring Boot listens on 8080 when server.port is not set (ServerProperties, "server.port" default)',
});

/** Keys that say an application's configuration is served from outside the tree. */
const CONFIG_CLIENT_RE = /^spring\.cloud\.(?:config|nacos\.config|consul\.config|zookeeper\.config)\./;

/**
 * Keys that bring in configuration this reader does not follow (review 2, item
 * 11): an import, even of a file on the classpath, another location, another
 * file name. What such configuration sets is not read, so the port is not known.
 */
const UNFOLLOWED_KEYS = Object.freeze([
  'spring.config.import', 'spring.config.location', 'spring.config.additional-location', 'spring.config.name',
]);

/** Keys that choose which profiles apply; with a placeholder in them, which files apply is not known. */
const PROFILE_KEY_RE = /^spring\.profiles\.(?:active|include|group\..+)$/;

/** What in one entry makes the application's configuration not fully read, or null. */
function unfollowedOf(key, value) {
  if (CONFIG_CLIENT_RE.test(`${key}.`)) return key.split('.').slice(0, 3).join('.');
  if (UNFOLLOWED_KEYS.includes(key)) return key;
  if (PROFILE_KEY_RE.test(key) && String(value).includes('${')) return `${key} (a placeholder)`;
  return null;
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** `spring.config.import[0]` and `spring.config.import.0` are the same key as `spring.config.import`. */
const normalizeIndex = (key) => String(key).replace(/\[\d+\]$/, '').replace(/\.\d+$/, '');

// What a Java source says about its application's port: src/core/server_ports_java.mjs.
export { portRecordsOfJava, serverPortsOfJava } from './server_ports_java.mjs';

/** The application a configuration file belongs to: the path up to its `resources` directory. */
function applicationOf(filePath) {
  const parts = String(filePath).split('\\').join('/').split('/');
  const at = parts.lastIndexOf('resources');
  return at < 0 ? path.posix.dirname(parts.join('/')) : parts.slice(0, at + 1).join('/');
}

/**
 * What ONE configuration file says about its application's port.
 *
 * @param {{path:string, text:string}} file
 * @returns {{file:string, app:string, ports:{port:number, line:number, conditional:boolean}[],
 *            unreadable:{raw:string, line:number}[], external:boolean}}
 */
export function serverPortsOfFile(file) {
  const entries = springConfigEntries(file, null);
  const conditional = conditionalDocuments(file.path, entries);
  const out = { file: file.path, app: applicationOf(file.path), ports: [], unreadable: [], external: false };
  for (const e of entries) {
    const key = relaxedKey(normalizeIndex(e.key));
    const unfollowed = unfollowedOf(key, e.value);
    if (unfollowed !== null) {
      if (out.external === false) out.external = unfollowed;
      continue;
    }
    if (key !== SERVER_PORT.key) continue;
    const raw = String(e.value).trim();
    // 0 is a port the application picks when it starts (review 4, W-8): no file states it.
    const port = portNumber(raw);
    if (port !== null) out.ports.push({ port, line: e.line, conditional: conditional(e.doc) });
    else out.unreadable.push({ raw, line: e.line });
  }
  return out;
}

/** One application's ports, or why they are not known. */
function portsOfApplication(app, files) {
  const unreadable = files.flatMap((f) => f.unreadable.map((u) => `${f.file}:${u.line} (${u.raw})`));
  if (unreadable.length > 0) return { app, ports: null, why: `server.port is not a number the tree states at ${unreadable.join(', ')}` };
  const external = files.filter((f) => f.external);
  if (external.length > 0) {
    return {
      app, ports: null,
      why: `${external.map((f) => `${f.file} (${f.external === true ? 'configuration from outside this tree' : f.external})`).join(', ')} brings in configuration this reader does not follow`,
    };
  }
  const declared = files.flatMap((f) => f.ports);
  const ports = new Set(declared.map((p) => p.port));
  const stated = [...ports].sort((a, b) => a - b);
  // With no profile active, a document that sets nothing leaves Spring's default.
  if (!declared.some((p) => !p.conditional)) ports.add(SERVER_PORT.defaultPort);
  return {
    app, ports: [...ports].sort((a, b) => a - b), stated,
    files: [...new Set(files.filter((f) => f.ports.length > 0).map((f) => f.file))].sort(),
    defaulted: !declared.some((p) => !p.conditional),
  };
}

/** The records by the application they are for, a deployment file's read as each one's it applies to. */
function byApplication(records) {
  const byApp = new Map();
  for (const r of withDeployments(records ?? [])) {
    if (!r || typeof r.app !== 'string') continue;
    if (!byApp.has(r.app)) byApp.set(r.app, []);
    byApp.get(r.app).push(r);
  }
  return byApp;
}

/**
 * THE PORTS THIS PACK LISTENS ON: known only when every application's are.
 * The ports read are listed either way, those of the applications whose port
 * is known; `defaulted` says one of them rests on Spring Boot's default, and
 * `stated` holds the ports a file states, without that default: a call on a
 * port only the default gives is not settled (review 4, W-7).
 *
 * @param {object[]} records  serverPortsOfFile results, one per configuration file
 * @returns {{known:boolean, ports:number[], stated:number[], files:string[], why:(string|null),
 *            applications:object[]}}
 */
export function serverPortsOf(records) {
  const byApp = byApplication(records);
  const applications = [...byApp.keys()].sort(cmp).map((app) => portsOfApplication(app, byApp.get(app)));
  if (applications.length === 0) {
    return { known: false, ports: [], stated: [], files: [], why: 'no Spring application configuration was read', applications };
  }
  const known = applications.filter((a) => a.ports !== null);
  const unknown = applications.filter((a) => a.ports === null);
  return {
    known: unknown.length === 0,
    ports: [...new Set(known.flatMap((a) => a.ports))].sort((a, b) => a - b),
    stated: [...new Set(known.flatMap((a) => a.stated))].sort((a, b) => a - b),
    files: [...new Set(known.flatMap((a) => a.files))].sort(cmp),
    defaulted: known.some((a) => a.defaulted),
    why: unknown.length === 0 ? null : unknown.map((a) => `${a.app}: ${a.why}`).join('; '),
    applications,
  };
}
