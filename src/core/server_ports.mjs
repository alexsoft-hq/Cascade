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
// its configuration sits in: two modules are two applications.
//
// WHAT MAKES IT UNKNOWN, and then nothing is decided by port at all:
//   - a `server.port` that is a placeholder (`${PORT:8080}`) or not a number: a
//     deployment sets it, so no file here states it
//   - an application that takes its configuration from outside the tree (a
//     config server, Nacos, Consul, ZooKeeper): its port is in that server
//   - no Spring application read at all
// One unknown application makes the whole pack's ports unknown, because a call
// on "another" port may be that application's.
//
// Pure: records in, one answer out. Discovery reads the files
// (src/core/discover.mjs); `cascade analyze` hands the answer to the web bridge.

import path from 'node:path';
import { springConfigEntries, conditionalDocuments, relaxedKey } from './springconfig.mjs';

/** Spring Boot's own key, and the port it listens on when nothing sets it. */
export const SERVER_PORT = Object.freeze({
  key: 'server.port',
  defaultPort: 8080,
  source: 'Spring Boot listens on 8080 when server.port is not set (ServerProperties, "server.port" default)',
});

/** Keys that say an application's configuration is served from outside the tree. */
const CONFIG_CLIENT_RE = /^spring\.cloud\.(?:config|nacos\.config|consul\.config|zookeeper\.config)\./;

/** A `spring.config.import` that names a location, not a file on the classpath. */
const REMOTE_IMPORT_RE = /(?:^|[,:\s])(?:configserver|nacos|consul|zookeeper|vault|aws-parameterstore|aws-secretsmanager|http|https):/;

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

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
    const key = relaxedKey(e.key);
    if (CONFIG_CLIENT_RE.test(`${key}.`) || (key === 'spring.config.import' && REMOTE_IMPORT_RE.test(e.value))) {
      out.external = true;
      continue;
    }
    if (key !== SERVER_PORT.key) continue;
    const raw = String(e.value).trim();
    if (/^\d{1,5}$/.test(raw)) out.ports.push({ port: Number(raw), line: e.line, conditional: conditional(e.doc) });
    else out.unreadable.push({ raw, line: e.line });
  }
  return out;
}

/** One application's ports, or why they are not known. */
function portsOfApplication(app, files) {
  const unreadable = files.flatMap((f) => f.unreadable.map((u) => `${f.file}:${u.line} (${u.raw})`));
  if (unreadable.length > 0) return { app, ports: null, why: `server.port is not a number the tree states at ${unreadable.join(', ')}` };
  const external = files.filter((f) => f.external).map((f) => f.file);
  if (external.length > 0) return { app, ports: null, why: `${external.join(', ')} takes the configuration from outside this tree` };
  const declared = files.flatMap((f) => f.ports);
  const ports = new Set(declared.map((p) => p.port));
  // With no profile active, a document that sets nothing leaves Spring's default.
  if (!declared.some((p) => !p.conditional)) ports.add(SERVER_PORT.defaultPort);
  return {
    app, ports: [...ports].sort((a, b) => a - b),
    files: [...new Set(files.filter((f) => f.ports.length > 0).map((f) => f.file))].sort(),
    defaulted: !declared.some((p) => !p.conditional),
  };
}

/**
 * THE PORTS THIS PACK LISTENS ON: known only when every application's are.
 *
 * @param {object[]} records  serverPortsOfFile results, one per configuration file
 * @returns {{known:boolean, ports:number[], files:string[], why:(string|null),
 *            applications:object[]}}
 */
export function serverPortsOf(records) {
  const byApp = new Map();
  for (const r of records ?? []) {
    if (!r || typeof r.app !== 'string') continue;
    if (!byApp.has(r.app)) byApp.set(r.app, []);
    byApp.get(r.app).push(r);
  }
  const applications = [...byApp.keys()].sort(cmp).map((app) => portsOfApplication(app, byApp.get(app)));
  if (applications.length === 0) {
    return { known: false, ports: [], files: [], why: 'no Spring application configuration was read', applications };
  }
  const unknown = applications.filter((a) => a.ports === null);
  if (unknown.length > 0) {
    return { known: false, ports: [], files: [], why: unknown.map((a) => `${a.app}: ${a.why}`).join('; '), applications };
  }
  return {
    known: true,
    ports: [...new Set(applications.flatMap((a) => a.ports))].sort((a, b) => a - b),
    files: [...new Set(applications.flatMap((a) => a.files))].sort(cmp),
    defaulted: applications.some((a) => a.defaulted),
    why: null,
    applications,
  };
}
