// springconfig.mjs — what a Spring project's own configuration says about WHO
// it is and WHERE it forwards a request (SPEC §7.3, §12.1 ①).
//
// Two facts live in `src/main/resources/application.yml` that this engine used
// to make a person type into the profile:
//
//   1. `spring.application.name` — the LOGICAL NAME the service answers to.
//      It is how one call among several candidates is settled: two projects
//      that both serve `GET /owners` are told apart by the name the caller
//      wrote, and nothing else in a call can tell them apart (src/mcp/
//      federation.mjs, `serversOf`).
//   2. `spring.cloud.gateway…routes` — the GATEWAY'S ROUTE TABLE. It is what
//      turns a frontend's `/api/customer/owners` into the `/owners` a sibling
//      service really serves, and which sibling that is.
//
// THREE RULES THIS MODULE KEEPS.
//
//  1. IT READS, IT DOES NOT GUESS. A `${VAR}` with no default is not a name, a
//     rewrite regex outside the plain form Spring documents is not a prefix
//     rule, and a `Path=` pattern with a wildcard in the middle is not a
//     prefix. Each of those becomes a diagnostic and no entry.
//  2. ONE YAML WALKER. The reader is `readYamlLeaves` in ./dbconfig.mjs, the
//     same one the datasource candidates come out of. A second parser would be
//     a second set of quoting and comment rules to disagree with.
//  3. NOTHING OUTSIDE THE TREE IS CLAIMED. A `spring.config.import` naming a
//     config server points at values that are not in this repository, so they
//     are not read and the run says so once, rather than reporting a route
//     table as complete when the deployment's is longer.
//
// Pure: text in, records out.

import path from 'node:path';
import { readYamlLeaves, parseProperties, looksLikeConnectionFile } from './dbconfig.mjs';

/** The file names Spring reads its own configuration from. */
const SPRING_CONFIG_NAME_RE = /^(?:application|bootstrap)(?:-[^./]+)?\.(?:ya?ml|properties)$/;

/** The key that names the service, in the one spelling Spring documents. */
const SERVICE_NAME_KEY = 'spring.application.name';

/**
 * Where a Spring Cloud Gateway route table can sit. The classic spelling and
 * the two the 2025 reorganisation added (`server.webflux`, `server.webmvc`),
 * plus the server-MVC one. A property name outside this set is not a route
 * table, and this reader does not go looking for one.
 */
const ROUTES_KEY_RE = /^spring\.cloud\.gateway(?:\.server\.webflux|\.server\.webmvc|\.mvc)?\.routes\.(\d+)\.(.+)$/;

/** The key path prefixes this reader is interested in at all. */
const INTEREST_RE = /^spring\.(?:application|config|cloud\.gateway)(?:\.|$)/;

/** A whole-value `${VAR}` or `${VAR:default}` placeholder. */
const PLACEHOLDER_RE = /^\$\{([^{}:]+)(?::([^{}]*))?\}$/;

/**
 * The filters that CHANGE THE PATH a request is forwarded with. `SetPath` is on
 * the list without being implemented on purpose: a route that carries one has a
 * back prefix this reader cannot compute, and saying so is the difference
 * between a gap and a wrong answer.
 */
const PATH_FILTERS = Object.freeze(['StripPrefix', 'PrefixPath', 'RewritePath', 'SetPath']);

/**
 * A rewrite regex in THE PLAIN FORM SPRING DOCUMENTS: literal path characters
 * and exactly one trailing `(?<name>.*)` or `(.*)` group. Anything else — an
 * alternation, a quantifier, a lookaround — is a program, and this reader
 * refuses to run it against a prefix and call the result a fact.
 */
const PLAIN_REWRITE_RE = /^\/?[A-Za-z0-9._~/-]*\((?:\?<([A-Za-z][A-Za-z0-9]*)>)?\.\*\)$/;

/** The replacement that goes with it: literal characters and one reference. */
const PLAIN_REPLACEMENT_RE = /^([A-Za-z0-9._~/-]*)(?:\$\\?\{([A-Za-z][A-Za-z0-9]*)\}|\$(\d))([A-Za-z0-9._~/-]*)$/;

/**
 * Whether a file is one Spring reads its own configuration from: an
 * `application*.yml` / `.yaml` / `.properties` or a `bootstrap.yml`, under a
 * `resources` directory. The directory is half the evidence — a stray
 * `application.yml` in a fixture directory of some vendored bundle is not this
 * project's configuration.
 *
 * The TEST layout is the caller's business (`src/core/discover.mjs` applies
 * `isTestPath`), because "which roots are test roots" is decided in one place.
 *
 * @param {string} relPath  a path relative to the scanned root
 * @returns {boolean}
 */
export function looksLikeSpringConfigFile(relPath) {
  const full = String(relPath ?? '').split('\\').join('/');
  const base = path.posix.basename(full).toLowerCase();
  if (!SPRING_CONFIG_NAME_RE.test(base)) return false;
  const dirs = full.slice(0, full.length - base.length).toLowerCase().split('/');
  if (!dirs.includes('resources')) return false;
  // The presentation-resource rule is the datasource reader's, and it is the
  // same rule here: a `.properties` under `static/` or `locale*/` is a
  // translation catalogue, whatever it is called.
  return looksLikeConnectionFile(full);
}

/**
 * Every configuration entry of one file, as `{key, value, line}` with the key
 * DOTTED: a nested YAML mapping, a flattened `spring.application.name:` line
 * and a `.properties` key all come out spelled the same way, which is what lets
 * one set of rules read all three.
 *
 * `[n]` in a properties key becomes `.n`, so a list index is a path segment
 * here exactly as it is in YAML.
 *
 * @param {{path:string, text:string}} file
 * @param {Object[]|null} [diagnostics]
 * @returns {{key:string, value:string, line:number, doc:number}[]}
 */
export function springConfigEntries(file, diagnostics = null) {
  const filePath = file && typeof file.path === 'string' ? file.path : '';
  const text = file && typeof file.text === 'string' ? file.text : '';
  const base = path.posix.basename(filePath.split('\\').join('/')).toLowerCase();
  if (base.endsWith('.properties')) {
    return parseProperties(text, null, filePath)
      .map((e) => ({ key: normalizeKey(e.key), value: e.value, line: e.line, doc: 0 }))
      .filter((e) => INTEREST_RE.test(e.key));
  }
  return readYamlLeaves(text, {
    sequences: true,
    diagnostics,
    filePath,
    interest: (keys) => INTEREST_RE.test(keys.map(String).join('.')),
  })
    .filter((l) => typeof l.value === 'string' && l.value !== '')
    .map((l) => ({ key: l.keyPath.map(String).join('.'), value: l.value, line: l.line, doc: l.doc }));
}

/** `a.b[0].c` -> `a.b.0.c`, so one set of rules reads YAML and properties alike. */
function normalizeKey(key) {
  return String(key ?? '').replace(/\[(\d+)\]/g, '.$1');
}

/**
 * The service name each file declares: `spring.application.name`, per document.
 *
 * A `${VAR:default}` value yields the DEFAULT — that is what runs when nobody
 * sets the variable, and it is written in the tree. A `${VAR}` with no default
 * yields nothing and a diagnostic: the name is somewhere else, and inventing
 * one would put a wrong name on every call the sidecar answers.
 *
 * @param {{path:string, text:string}[]} files
 * @param {Object[]|null} [diagnostics]
 * @returns {{name:string, file:string}[]} sorted by name, then file
 */
export function findServiceNames(files, diagnostics = null) {
  const out = [];
  const seen = new Set();
  for (const file of files ?? []) {
    if (!file || typeof file.path !== 'string' || typeof file.text !== 'string') continue;
    for (const e of springConfigEntries(file, diagnostics)) {
      if (e.key !== SERVICE_NAME_KEY) continue;
      const value = resolvePlaceholder(e.value);
      if (value === null) {
        diag(diagnostics, 'info', 'SERVICE_NAME_UNREADABLE', file.path,
          `${SERVICE_NAME_KEY} on line ${e.line} is ${JSON.stringify(e.value)}, which names a value this tree does not carry, so no service name was read from it`);
        continue;
      }
      const key = `${value} <- ${file.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name: value, file: file.path });
    }
  }
  out.sort((a, b) => cmp(a.name, b.name) || cmp(a.file, b.file));
  return out;
}

/**
 * The gateway routes each file declares, one entry per `Path=` prefix.
 *
 * @param {{path:string, text:string}[]} files
 * @param {Object[]|null} [diagnostics]
 * @returns {{front:string, to:string, service:(string|null), file:string, id:(string|null)}[]}
 *          sorted by front prefix, then file
 */
export function findGatewayRoutes(files, diagnostics = null) {
  const out = [];
  for (const file of files ?? []) {
    if (!file || typeof file.path !== 'string' || typeof file.text !== 'string') continue;
    // "<doc>:<table>:<index>" -> the route, with its predicates and filters kept
    // BY THEIR OWN INDEX: a `Host` predicate's `patterns` argument is not a path,
    // and only the index that named `Path` says which arguments are.
    const routes = new Map();
    for (const e of springConfigEntries(file, diagnostics)) {
      const key = normalizeKey(e.key);
      const m = ROUTES_KEY_RE.exec(key);
      if (!m) continue;
      const table = key.slice(0, key.length - `.routes.${m[1]}.${m[2]}`.length);
      const id = `${e.doc}:${table}:${m[1]}`;
      if (!routes.has(id)) routes.set(id, { id: null, uri: null, predicates: new Map(), filters: new Map() });
      const route = routes.get(id);
      const field = m[2];
      const at = (map, index) => {
        if (!map.has(index)) map.set(index, { shortcut: null, name: null, args: {} });
        return map.get(index);
      };
      const parts = field.split('.');
      if (field === 'id') route.id = e.value;
      else if (field === 'uri') route.uri = e.value;
      else if (/^predicates\.\d+$/.test(field)) at(route.predicates, parts[1]).shortcut = e.value;
      else if (/^predicates\.\d+\.name$/.test(field)) at(route.predicates, parts[1]).name = e.value;
      else if (/^predicates\.\d+\.args\.[A-Za-z0-9_]+$/.test(field)) at(route.predicates, parts[1]).args[parts[3]] = e.value;
      else if (/^filters\.\d+$/.test(field)) at(route.filters, parts[1]).shortcut = e.value;
      else if (/^filters\.\d+\.name$/.test(field)) at(route.filters, parts[1]).name = e.value;
      else if (/^filters\.\d+\.args\.[A-Za-z0-9_]+$/.test(field)) at(route.filters, parts[1]).args[parts[3]] = e.value;
    }
    for (const [key, route] of [...routes].sort((a, b) => cmp(a[0], b[0]))) {
      const label = route.id ?? `route ${key.split(':').pop()}`;
      const filters = filterDeclarations(route.filters);
      const paths = pathPatterns(route.predicates);
      if (paths.length === 0) continue; // a route matched by something other than a path: not a prefix rule
      const service = serviceOfUri(route.uri);
      for (const pattern of paths) {
        const front = frontPrefixOf(pattern);
        if (front === null) {
          diag(diagnostics, 'info', 'GATEWAY_ROUTE_UNREADABLE', file.path,
            `${label} matches ${JSON.stringify(pattern)}, which is not a path PREFIX (a wildcard sits inside it), so no gateway route was read from it`);
          continue;
        }
        const to = backPrefixOf(front, filters, { file: file.path, label, diagnostics });
        if (to === null) continue;
        out.push({ front, to, service, file: file.path, id: route.id ?? null });
      }
    }
  }
  out.sort((a, b) => cmp(a.front, b.front) || cmp(a.file, b.file));
  return out;
}

/**
 * The files that import configuration from OUTSIDE this tree — a config server,
 * a URL. What lives there is not in the repository, so it is not read, and a
 * route table or a service name from such a file may be only part of the truth.
 * @param {{path:string, text:string}[]} files
 * @returns {{file:string, value:string}[]}
 */
export function findExternalConfigImports(files) {
  const out = [];
  for (const file of files ?? []) {
    if (!file || typeof file.path !== 'string' || typeof file.text !== 'string') continue;
    for (const e of springConfigEntries(file, null)) {
      if (normalizeKey(e.key) !== 'spring.config.import') continue;
      if (!/(?:^|:)(?:configserver|http|https):/.test(e.value)) continue;
      out.push({ file: file.path, value: e.value });
    }
  }
  out.sort((a, b) => cmp(a.file, b.file) || cmp(a.value, b.value));
  return out;
}

// ---------------------------------------------------------------------------
// The pieces
// ---------------------------------------------------------------------------

/**
 * A value with its `${VAR:default}` resolved to the default, or null when the
 * value depends on something this tree does not carry.
 * @param {string} value
 * @returns {string|null}
 */
export function resolvePlaceholder(value) {
  const text = String(value ?? '').trim();
  if (!text.includes('${')) return text === '' ? null : text;
  const m = PLACEHOLDER_RE.exec(text);
  if (!m) return null;                       // a name built out of a placeholder
  const fallback = m[2];
  if (fallback === undefined || fallback === '') return null;
  return fallback.includes('${') ? null : fallback;
}

/** Whether a predicate NAME is the Path one, in the spelling Spring documents. */
function isPathName(name) {
  return String(name ?? '').trim().toLowerCase() === 'path';
}

/**
 * The path patterns a route's predicates name, in either spelling: the shortcut
 * (`Path=/a/**,/b/**`) or the long form (`name: Path` with `args.patterns`).
 * A predicate that is not a Path contributes nothing, whatever it is called.
 * @param {Map<string, {shortcut:(string|null), name:(string|null), args:Object}>} predicates
 * @returns {string[]}
 */
function pathPatterns(predicates) {
  const out = [];
  for (const [, p] of [...predicates].sort((a, b) => Number(a[0]) - Number(b[0]))) {
    if (typeof p.shortcut === 'string') {
      const eq = p.shortcut.indexOf('=');
      if (eq >= 0 && isPathName(p.shortcut.slice(0, eq))) out.push(...splitPatterns(p.shortcut.slice(eq + 1)));
      continue;
    }
    if (!isPathName(p.name)) continue;
    for (const key of ['patterns', 'pattern', '_genkey_0']) {
      if (typeof p.args[key] === 'string') { out.push(...splitPatterns(p.args[key])); break; }
    }
  }
  return out;
}

/**
 * A route's filters as SHORTCUT text, whichever spelling the file used, so one
 * rule reads both. A path filter whose long-form arguments are not the ones
 * this reader knows comes back as its bare name, which `backPrefixOf` refuses:
 * a filter that moves the path and was not understood must not be dropped.
 * @param {Map<string, {shortcut:(string|null), name:(string|null), args:Object}>} filters
 * @returns {string[]}
 */
function filterDeclarations(filters) {
  const out = [];
  for (const [, f] of [...filters].sort((a, b) => Number(a[0]) - Number(b[0]))) {
    if (typeof f.shortcut === 'string') { out.push(f.shortcut); continue; }
    const name = typeof f.name === 'string' ? f.name.trim() : '';
    if (name === '') continue;
    if (name === 'StripPrefix' && f.args.parts !== undefined) out.push(`StripPrefix=${f.args.parts}`);
    else if (name === 'PrefixPath' && f.args.prefix !== undefined) out.push(`PrefixPath=${f.args.prefix}`);
    else if (name === 'RewritePath' && f.args.regexp !== undefined && f.args.replacement !== undefined) {
      out.push(`RewritePath=${f.args.regexp},${f.args.replacement}`);
    } else out.push(name);
  }
  return out;
}

const splitPatterns = (value) => String(value ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');

/**
 * The PREFIX a `Path=` pattern names: the pattern with its `/**` or `/*` tail
 * removed. Null when the wildcard is not a tail: a pattern with a star in the
 * middle matches paths no single prefix expresses, and half a rule is worse
 * than none.
 * @param {string} pattern
 * @returns {string|null}
 */
export function frontPrefixOf(pattern) {
  let p = String(pattern ?? '').trim();
  if (p === '') return null;
  if (!p.startsWith('/')) p = `/${p}`;
  p = p.replace(/\/\*\*?$/, '');
  if (p.endsWith('/')) p = p.slice(0, -1);
  if (/[*?{}]/.test(p)) return null;
  return p;
}

/**
 * The prefix the BACK END sees, from the front prefix and the route's filters.
 * Null when a filter changes the path in a way this reader will not guess at —
 * with a diagnostic naming the file and the route.
 *
 * @param {string} front
 * @param {string[]} filters  filter declarations, shortcut form (`StripPrefix=2`)
 * @param {{file:string, label:string, diagnostics:(Object[]|null)}} where
 * @returns {string|null}
 */
export function backPrefixOf(front, filters, where = {}) {
  let out = front;
  for (const raw of filters ?? []) {
    const text = String(raw ?? '').trim();
    const eq = text.indexOf('=');
    const name = (eq < 0 ? text : text.slice(0, eq)).trim();
    const args = eq < 0 ? '' : text.slice(eq + 1).trim();
    if (!PATH_FILTERS.includes(name)) continue;
    if (eq < 0) {
      refuse(where, `its ${name} filter is written in a form whose arguments this reader did not find, and that filter moves the path`);
      return null;
    }
    if (name === 'StripPrefix') {
      const n = Number(args);
      if (!Number.isInteger(n) || n < 0) {
        refuse(where, `its StripPrefix filter says ${JSON.stringify(args)}, which is not a number of segments`);
        return null;
      }
      const segments = out.split('/').filter((s) => s !== '');
      out = segments.length <= n ? '' : `/${segments.slice(n).join('/')}`;
      continue;
    }
    if (name === 'PrefixPath') {
      const prefix = args.startsWith('/') ? args : `/${args}`;
      if (prefix === '/') { refuse(where, 'its PrefixPath filter names no prefix'); return null; }
      out = `${prefix.replace(/\/$/, '')}${out}`;
      continue;
    }
    if (name === 'RewritePath') {
      const rewritten = rewritePrefix(out, args, where);
      if (rewritten === null) return null;
      out = rewritten;
      continue;
    }
    // SetPath, and anything else that lands on this list: the path it forwards
    // is not a function of the prefix alone.
    refuse(where, `its ${name} filter sets the whole forwarded path, which is not a prefix rule this reader can express`);
    return null;
  }
  return out === '/' ? '' : out;
}

/** `RewritePath=<regex>,<replacement>` applied to a prefix, or null. */
function rewritePrefix(front, args, where) {
  const comma = String(args ?? '').indexOf(',');
  if (comma < 0) {
    refuse(where, 'its RewritePath filter carries no `<regex>,<replacement>` pair');
    return null;
  }
  const source = args.slice(0, comma).trim();
  const replacement = args.slice(comma + 1).trim();
  const plain = PLAIN_REWRITE_RE.exec(source);
  const target = PLAIN_REPLACEMENT_RE.exec(replacement);
  if (!plain || !target) {
    refuse(where, `its RewritePath filter is ${JSON.stringify(`${source},${replacement}`)}, which is outside the plain `
      + '`/prefix/(?<name>.*)` form this reader reads, so it was skipped rather than guessed');
    return null;
  }
  let m;
  try {
    m = new RegExp(`^${source}$`).exec(front);
  } catch {
    refuse(where, `its RewritePath regular expression ${JSON.stringify(source)} could not be compiled`);
    return null;
  }
  if (!m) {
    refuse(where, `its RewritePath regular expression ${JSON.stringify(source)} does not match the prefix ${JSON.stringify(front)}, `
      + 'so what it forwards depends on the rest of the path and no prefix rule was read');
    return null;
  }
  // The replacement may only refer to the ONE group the plain form allows, by
  // name or as `$1`. A reference to a second group is a rewrite this reader
  // did not understand, whatever the rest of it looks like.
  if (target[3] !== undefined && target[3] !== '1') {
    refuse(where, `its RewritePath replacement ${JSON.stringify(replacement)} refers to a capture group the regular expression does not have`);
    return null;
  }
  const captured = m[1] ?? '';
  const out = `${target[1]}${captured}${target[4]}`;
  return out.startsWith('/') ? out : `/${out}`;
}

/**
 * The service a route's `uri` names: the host of `lb://<service>` (Spring's own
 * spelling for "whatever answers to this name"), or the host of an `http(s)`
 * address. Null when the uri is a placeholder or something else.
 * @param {string|null} uri
 * @returns {string|null}
 */
export function serviceOfUri(uri) {
  const text = resolvePlaceholder(uri ?? '');
  if (text === null) return null;
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]+)/i.exec(text.trim());
  if (!m) return null;
  const host = m[2].split('@').pop().replace(/:\d+$/, '');
  return host === '' ? null : host;
}

function refuse(where, why) {
  diag(where.diagnostics ?? null, 'info', 'GATEWAY_ROUTE_UNREADABLE', where.file ?? '',
    `${where.label ?? 'a gateway route'}: ${why}`);
}

function diag(list, severity, kind, filePath, reason) {
  if (Array.isArray(list)) list.push({ kind, severity, path: filePath, reason });
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
