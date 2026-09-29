// server_ports_deploy.mjs — the port a deployment file in the tree starts an
// application on.
//
// WHY. `server.port` in an application's configuration (src/core/server_ports.mjs)
// is how it runs when nothing else says otherwise, and a deployment says
// otherwise as a matter of course (review 4, W-9): a Dockerfile's
// `ENTRYPOINT [..., "--server.port=9090"]`, a compose file's `SERVER_PORT: 9090`.
// Such a file in the tree is one more way the application runs, as a profile
// is: its port is READ, beside the configuration's. One it sets from somewhere
// else (`--server.port=${ADMIN_PORT}`) makes the port not known.
//
// WHAT IS READ, AS DATA. `PORT_SET_IN_DEPLOYMENT` names the files and the
// spellings: Spring Boot's own command-line argument, the system property and
// the environment variable its relaxed binding reads. A line that starts with
// `#` is a comment in each of these formats and says nothing.
//
// WHICH APPLICATION. A deployment file is for the applications under its own
// directory; one beside no application (`docker/compose.yml`) may be for any
// of them, so it is read as every application's.
//
// Pure: a path and a text in, a record out.

import path from 'node:path';

/** The files a deployment is written in, and how each writes the port. */
export const PORT_SET_IN_DEPLOYMENT = Object.freeze({
  files: [/^Dockerfile(\.[\w.-]+)?$/i, /\.dockerfile$/i, /^(docker-)?compose(\.[\w.-]+)?\.ya?ml$/i],
  settings: [
    /--server\.port[=\s]+["']?([^\s"',\]]+)/g,
    /-Dserver\.port=["']?([^\s"',\]]+)/g,
    /\bSERVER_PORT["']?\s*[:=\s]\s*["']?([^\s"',\]}]+)/g,
  ],
});

/** Whether a file name is one a deployment is written in. */
export function isDeploymentFile(name) {
  return PORT_SET_IN_DEPLOYMENT.files.some((re) => re.test(String(name)));
}

/** A port number a text states: 1 to 65535. `0` is one the application picks when it starts. */
export function portNumber(raw) {
  const n = /^\d{1,5}$/.test(String(raw)) ? Number(raw) : 0;
  return n >= 1 && n <= 65535 ? n : null;
}

/**
 * WHAT ONE DEPLOYMENT FILE SAYS ABOUT THE PORT, in the shape a configuration
 * file's record has, with `app: null` and the directory it applies under
 * (`deploy`); null when it says nothing. Each port is `conditional`: it is one
 * way the application runs, not the only one.
 */
export function serverPortsOfDeployment(file) {
  const lines = String(file.text).split('\n').map((l) => (/^\s*#/.test(l) ? '' : l));
  const ports = [];
  const unreadable = [];
  lines.forEach((l, i) => {
    for (const re of PORT_SET_IN_DEPLOYMENT.settings) {
      for (const m of l.matchAll(re)) {
        const port = portNumber(m[1]);
        if (port !== null) ports.push({ port, line: i + 1, conditional: true });
        else unreadable.push({ raw: m[1], line: i + 1 });
      }
    }
  });
  if (ports.length === 0 && unreadable.length === 0) return null;
  const dir = path.posix.dirname(String(file.path).split('\\').join('/'));
  return { file: file.path, app: null, deploy: dir === '.' ? '' : dir, ports, unreadable, external: false };
}

/**
 * The records with each deployment file's read as the applications' it is
 * for: those under its directory, or every one when none is.
 */
export function withDeployments(records) {
  const apps = [...new Set(records.filter((r) => r && typeof r.app === 'string').map((r) => r.app))];
  const out = [];
  for (const r of records) {
    if (!r || typeof r.deploy !== 'string') { out.push(r); continue; }
    const under = apps.filter((a) => r.deploy === '' || a === r.deploy || a.startsWith(`${r.deploy}/`));
    for (const app of under.length > 0 ? under : apps) out.push({ ...r, app });
  }
  return out;
}
