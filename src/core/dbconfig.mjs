// dbconfig.mjs — "where would this project's DB be, if we asked it?" (SPEC §12.1
// step ①, §15 M5).
//
// It reads the files a Spring/MyBatis project keeps its datasource in
// (`application.yml`, `*.properties`, `.env`, or any file that simply spells a
// JDBC URL out) and returns CANDIDATES: host, port, database, dialect, and a
// REFERENCE to the credentials — never a credential value.
//
// THREE RULES THIS MODULE EXISTS TO KEEP:
//
//  1. A PASSWORD VALUE NEVER ENTERS THE RESULT. Not as a field, not inside the
//     returned `url`, not in a diagnostic. A candidate says `passwordPresent:
//     true` and where the password would come from (`<literal in file>` or the
//     `${VAR}` the file names). The unit tests assert the literal string of a
//     fixture password does not occur anywhere in `JSON.stringify(result)` —
//     because a redaction that is only in the docs is not a redaction (§17.3).
//
//  2. `${VAR}` PLACEHOLDERS ARE NOT RESOLVED HERE. A file that says
//     `username: ${DB_USER}` yields `usernameRef: '${DB_USER}'`. Reading
//     `process.env` in a parser would make the answer depend on the shell that
//     ran it, and would quietly pull a real secret into a printable object.
//
//  3. WHAT CANNOT BE READ BECOMES A DIAGNOSTIC, NEVER A GUESS. The YAML reader
//     below is deliberately minimal (see `readSpringDatasourceYaml`); every
//     construct outside its documented subset produces an `UNSUPPORTED_YAML`
//     diagnostic and the line is skipped, so a half-understood file cannot turn
//     into a confident-looking connection target.
//
// Nothing here connects to anything: this module is pure text in, objects out.
// Deciding to connect is a separate, explicitly confirmed step (§12.3, §17.5).

import path from 'node:path';

/** The candidate kinds, by the file the candidate was read out of. */
export const CONNECTION_KINDS = Object.freeze(['spring-yml', 'spring-properties', 'dotenv', 'jdbc-url']);

/** The dialects this engine can query a live catalog from (§12.2). */
export const CONNECTION_DIALECTS = Object.freeze(['mysql', 'postgres', 'oracle']);

/**
 * What `passwordRef` says when the password is written out in the file itself.
 * The VALUE is never carried; this constant is the whole of what is reported.
 */
export const PASSWORD_LITERAL_REF = '<literal in file>';

/** What a redacted secret is replaced by inside a URL. */
export const REDACTED = '***';

/** Default ports, applied by the CALLER (a candidate keeps `port: null` when the
 * file did not say one — this module reports what it read, not what it assumes). */
export const DEFAULT_PORTS = Object.freeze({ mysql: 3306, postgres: 5432, oracle: 1521 });

// Key spellings, normalized (lower-cased, `-`/`_` removed) before lookup, so
// `jdbc-url`, `jdbcUrl` and `JDBC_URL` are one key.
const URL_KEYS = new Set(['url', 'jdbcurl', 'connectionurl', 'jdbcconnectionurl', 'datasourceurl']);
const USER_KEYS = new Set(['username', 'user', 'userid', 'uid']);
const PASSWORD_KEYS = new Set(['password', 'passwd', 'pass', 'pwd']);

// The `.env` keys the spec names, plus the obvious siblings. Exact names (an
// env file has no dotted structure to group by).
const ENV_URL_KEYS = ['DB_URL', 'JDBC_URL', 'DATABASE_URL', 'SPRING_DATASOURCE_URL'];
const ENV_USER_KEYS = ['DB_USER', 'DB_USERNAME', 'JDBC_USER', 'DATABASE_USER', 'DATABASE_USERNAME', 'SPRING_DATASOURCE_USERNAME'];
const ENV_PASSWORD_KEYS = ['DB_PASSWORD', 'DB_PASS', 'JDBC_PASSWORD', 'DATABASE_PASSWORD', 'SPRING_DATASOURCE_PASSWORD'];

// A value that is a connection URL at all. Anything else under a `url` key
// (a REST endpoint, a redis address) is not a candidate.
const URL_LIKE_RE = /^(jdbc:|mysql:\/\/|mariadb:\/\/|postgres:\/\/|postgresql:\/\/|oracle:\/\/)/i;

// A `${VAR}` (or `${VAR:default}`) placeholder, whole-value.
const PLACEHOLDER_RE = /^\$\{[^}]*\}$/;

const norm = (key) => String(key ?? '').toLowerCase().replace(/[-_]/g, '');

/**
 * Every connection-info candidate in the given files, sorted by path.
 *
 * The file's name decides how it is read: `.yml`/`.yaml` through the minimal
 * Spring-datasource YAML reader, `.properties` as a Java properties file,
 * `.env`/`*.env` as a dotenv file, anything else by scanning for a bare JDBC URL
 * (the `DataSource` bean case — a URL written into Java or XML).
 *
 * @param {{path:string, text:string}[]} files
 * @param {Object[]|null} [diagnostics]  if a list is passed, structured
 *        `{kind, severity, path, reason}` entries are appended to it
 * @returns {{path:string, kind:string, url:string, host:(string|null),
 *            port:(number|null), database:(string|null), dialect:(string|null),
 *            usernameRef:(string|null), passwordPresent:boolean,
 *            passwordRef:(string|null)}[]}
 */
export function findConnectionCandidates(files, diagnostics = null) {
  const out = [];
  for (const file of files ?? []) {
    if (!file || typeof file.path !== 'string' || typeof file.text !== 'string') continue;
    const kind = kindOfFile(file.path);
    let found;
    try {
      if (kind === 'spring-yml') found = fromYaml(file, diagnostics);
      else if (kind === 'spring-properties') found = fromProperties(file, diagnostics);
      else if (kind === 'dotenv') found = fromDotenv(file, diagnostics);
      else found = fromLooseText(file, diagnostics);
    } catch (e) {
      diag(diagnostics, 'warn', 'CONNECTION_FILE_UNREADABLE', file.path,
        `could not read connection info: ${e.message}`);
      found = [];
    }
    out.push(...found);
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1
    : a.kind < b.kind ? -1 : a.kind > b.kind ? 1
      : a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  return out;
}

/**
 * How a file will be read, from its name alone.
 * @param {string} filePath
 * @returns {'spring-yml'|'spring-properties'|'dotenv'|'jdbc-url'}
 */
export function kindOfFile(filePath) {
  const base = path.basename(String(filePath ?? '')).toLowerCase();
  if (base === '.env' || base.endsWith('.env')) return 'dotenv';
  if (base.endsWith('.yml') || base.endsWith('.yaml')) return 'spring-yml';
  if (base.endsWith('.properties')) return 'spring-properties';
  return 'jdbc-url';
}

/**
 * Directory names that hold PRESENTATION resources, never a datasource. A
 * `.properties` under one of these is a translation catalogue or a static asset
 * of some vendored web UI — jeecg-boot ships a PDF.js locale file with 208 lines
 * this reader cannot parse, and every one of them used to become a diagnostic
 * about a file that was never a connection candidate in the first place.
 */
const NON_CONFIG_DIRS = Object.freeze(['static', 'public', 'templates', 'i18n']);

/** A resource-bundle name: `messages.properties`, `messages_zh_CN.properties`. */
const MESSAGE_BUNDLE_RE = /^messages?[_.-]?/;

/**
 * A LOCALE SUFFIX, deliberately narrow: `_xx_XX` (language + country), the shape
 * a Java resource bundle uses. A bare two-letter `_xx` is NOT enough — a real
 * config called `app_db.properties` ends the same way, and skipping it would
 * lose exactly the file this module exists to find.
 */
const LOCALE_SUFFIX_RE = /_[a-z]{2}_[A-Za-z]{2,4}\.properties$/;

/**
 * Whether a file is worth reading for connection info at all — used by the tree
 * walk so it does not read every file in the repository.
 *
 * Pass the path RELATIVE TO THE SCANNED ROOT when you have it: the directory is
 * half the evidence, and a bare basename cannot tell `resources/application.yml`
 * from `static/generic/web/locale/locale.properties`.
 *
 * @param {string} filePath
 * @returns {boolean}
 */
export function looksLikeConnectionFile(filePath) {
  const full = String(filePath ?? '').split('\\').join('/');
  const base = path.posix.basename(full).toLowerCase();
  const isConfigName = base === '.env' || base.endsWith('.env')
    || base.endsWith('.yml') || base.endsWith('.yaml')
    || base.endsWith('.properties');
  if (!isConfigName) return false;
  const dirs = full.slice(0, full.length - path.posix.basename(full).length).toLowerCase().split('/');
  for (const d of dirs) {
    if (d === '') continue;
    if (NON_CONFIG_DIRS.includes(d) || d.startsWith('locale')) return false;
  }
  if (base.endsWith('.properties') && (MESSAGE_BUNDLE_RE.test(base) || LOCALE_SUFFIX_RE.test(base))) return false;
  return true;
}

/**
 * Keys that make a `.properties` file plausibly a CONNECTION file at all. Used
 * only to decide whether an unparsable line is worth reporting: a line this
 * reader could not read in a file that holds no datasource key is not a gap in
 * the analysis, it is somebody else's file.
 */
function holdsDatasourceKey(entries) {
  for (const e of entries) {
    const key = String(e.key ?? '');
    const lower = key.toLowerCase();
    if (lower.startsWith('spring.datasource.')) return true;
    const last = norm(key.split('.').pop());
    if (URL_KEYS.has(last) || USER_KEYS.has(last) || PASSWORD_KEYS.has(last)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------

/**
 * Parse a connection URL into its parts. Understands, per SPEC §12:
 *
 *   jdbc:mysql://host:3306/db?params        jdbc:mariadb://host/db
 *   jdbc:postgresql://host:5432/db          postgres://host/db, postgresql://…
 *   jdbc:oracle:thin:@//host:1521/service   jdbc:oracle:thin:@host:1521:sid
 *   jdbc:oracle:thin:user/pw@//host/svc     mysql://host/db
 *
 * Credentials that the URL itself carries (`user:pw@host`, `?password=…`, the
 * Oracle `user/pw@` prefix) are reported as REFERENCES and removed from the
 * returned `url` — the returned string is safe to print and to store.
 *
 * @param {string} raw
 * @returns {{url:string, host:(string|null), port:(number|null),
 *            database:(string|null), dialect:(string|null),
 *            usernameRef:(string|null), passwordPresent:boolean,
 *            passwordRef:(string|null), notes:string[]}|null}
 *          null when the string is not a connection URL at all
 */
export function parseConnectionUrl(raw) {
  const text = String(raw ?? '').trim();
  if (text === '' || !URL_LIKE_RE.test(text)) return null;

  const notes = [];
  let usernameRef = null;
  let passwordPresent = false;
  let passwordRef = null;

  const lower = text.toLowerCase();
  let dialect;
  let rest;              // everything after the scheme, i.e. `//host:port/db?…`
  let oracle = false;

  if (lower.startsWith('jdbc:oracle:')) {
    dialect = 'oracle';
    oracle = true;
    // jdbc:oracle:<drivertype>:[user/password]@<connect-identifier>
    const at = text.indexOf('@');
    if (at < 0) return { url: redactUrl(text), host: null, port: null, database: null, dialect, usernameRef: null, passwordPresent: false, passwordRef: null, notes: ['no `@` in the Oracle URL, so host and service could not be read'] };
    const head = text.slice(0, at);
    rest = text.slice(at + 1);
    const creds = head.split(':').slice(3).join(':'); // after jdbc:oracle:<type>:
    if (creds) {
      const slash = creds.indexOf('/');
      if (slash >= 0) {
        usernameRef = creds.slice(0, slash) || null;
        const pw = creds.slice(slash + 1);
        if (pw !== '') { passwordPresent = true; passwordRef = refFor(pw); }
      } else {
        usernameRef = creds;
      }
    }
  } else {
    const m = /^(?:jdbc:)?([a-z0-9+]+):\/\//i.exec(text);
    if (!m) return null;
    dialect = dialectOf(m[1]);
    rest = text.slice(m[0].length - 2); // keep the leading `//`
  }

  let host = null;
  let port = null;
  let database = null;

  if (oracle) {
    if (rest.startsWith('//')) {
      // @//host:port/service
      const body = rest.slice(2);
      const slash = body.indexOf('/');
      const hostport = slash >= 0 ? body.slice(0, slash) : body;
      database = slash >= 0 ? stripQuery(body.slice(slash + 1)) : null;
      ({ host, port } = splitHostPort(hostport, notes));
    } else if (rest.startsWith('(')) {
      // A full TNS descriptor. Deliberately NOT parsed — a wrong host here is a
      // connection to the wrong machine, so it is reported as unread (§12.3).
      notes.push('the Oracle URL uses a TNS descriptor, which this reader does not parse. Pass --host/--port/--database explicitly');
    } else {
      // @host:port:sid
      const parts = rest.split(':');
      host = parts[0] || null;
      if (parts.length >= 2 && /^\d+$/.test(parts[1])) port = Number(parts[1]);
      if (parts.length >= 3) database = parts.slice(2).join(':') || null;
      else notes.push('the Oracle URL names no SID/service after the port');
    }
  } else {
    const body = rest.startsWith('//') ? rest.slice(2) : rest;
    // userinfo@authority
    const at = body.lastIndexOf('@');
    let authority = body;
    if (at >= 0) {
      const userinfo = body.slice(0, at);
      authority = body.slice(at + 1);
      const colon = userinfo.indexOf(':');
      if (colon >= 0) {
        usernameRef = decodeMaybe(userinfo.slice(0, colon)) || null;
        const pw = userinfo.slice(colon + 1);
        if (pw !== '') { passwordPresent = true; passwordRef = refFor(pw); }
      } else if (userinfo !== '') {
        usernameRef = decodeMaybe(userinfo) || null;
      }
    }
    const slash = authority.indexOf('/');
    const hostport = slash >= 0 ? authority.slice(0, slash) : authority;
    const tail = slash >= 0 ? authority.slice(slash + 1) : '';
    database = stripQuery(tail) || null;
    ({ host, port } = splitHostPort(hostport, notes));
  }

  // Credentials smuggled in the query string (`?user=…&password=…`).
  const q = text.indexOf('?');
  if (q >= 0) {
    for (const pair of text.slice(q + 1).split('&')) {
      const eq = pair.indexOf('=');
      if (eq < 0) continue;
      const k = norm(decodeMaybe(pair.slice(0, eq)));
      const v = pair.slice(eq + 1);
      if (USER_KEYS.has(k) && v !== '' && usernameRef === null) usernameRef = decodeMaybe(v);
      if (PASSWORD_KEYS.has(k) && v !== '') { passwordPresent = true; passwordRef = passwordRef ?? refFor(decodeMaybe(v)); }
    }
  }

  return {
    url: redactUrl(text),
    host, port, database, dialect,
    usernameRef, passwordPresent, passwordRef,
    notes,
  };
}

/**
 * A connection URL with every password removed: the `user:PW@host` form, the
 * Oracle `user/PW@` form, and `?password=PW` query parameters all become `***`.
 * Anything this function is unsure about is left ALONE only when it cannot be a
 * secret — the three shapes above are the only places a URL can carry one.
 * @param {string} raw
 * @returns {string}
 */
export function redactUrl(raw) {
  let text = String(raw ?? '');
  // 1. scheme://user:PW@host
  text = text.replace(/(:\/\/[^/@\s:]*):[^/@\s]*@/, `$1:${REDACTED}@`);
  // 2. jdbc:oracle:thin:user/PW@
  text = text.replace(/^(jdbc:oracle:[^:@\s]+:[^/@\s]+)\/[^@\s]*@/i, `$1/${REDACTED}@`);
  // 3. ?password=PW / &pwd=PW (any spelling in PASSWORD_KEYS)
  text = text.replace(/([?&])([A-Za-z_-]+)=([^&\s]*)/g, (whole, sep, key, value) => (
    PASSWORD_KEYS.has(norm(key)) && value !== '' ? `${sep}${key}=${REDACTED}` : whole
  ));
  return text;
}

function dialectOf(scheme) {
  const s = String(scheme ?? '').toLowerCase();
  if (s === 'mysql' || s === 'mariadb') return 'mysql';        // MariaDB speaks the MySQL catalog
  if (s === 'postgres' || s === 'postgresql') return 'postgres';
  if (s === 'oracle') return 'oracle';
  return null;                                                  // an unknown scheme is NOT guessed
}

function splitHostPort(hostport, notes) {
  let s = String(hostport ?? '');
  if (s === '') return { host: null, port: null };
  if (s.includes(',')) {
    notes.push(`the URL lists several hosts (${s}); the first one is reported`);
    s = s.split(',')[0];
  }
  if (s.startsWith('[')) {                    // [::1]:5432
    const close = s.indexOf(']');
    const host = close > 0 ? s.slice(0, close + 1) : s;
    const tail = close > 0 ? s.slice(close + 1) : '';
    const port = /^:(\d+)$/.exec(tail);
    return { host, port: port ? Number(port[1]) : null };
  }
  const colon = s.lastIndexOf(':');
  if (colon < 0) return { host: s, port: null };
  const portText = s.slice(colon + 1);
  if (!/^\d+$/.test(portText)) return { host: s, port: null };
  return { host: s.slice(0, colon) || null, port: Number(portText) };
}

function stripQuery(s) {
  const text = String(s ?? '');
  const cut = text.search(/[?;]/);
  return (cut >= 0 ? text.slice(0, cut) : text).trim();
}

function decodeMaybe(s) {
  try { return decodeURIComponent(String(s ?? '')); } catch { return String(s ?? ''); }
}

/**
 * The REFERENCE for a secret written in a file: the `${VAR}` placeholder itself
 * when the file only points at one, and the fixed `<literal in file>` marker
 * when the file spells the secret out. The value is never returned.
 * @param {string} value
 * @returns {string}
 */
export function refFor(value) {
  const text = String(value ?? '');
  return PLACEHOLDER_RE.test(text.trim()) ? text.trim() : PASSWORD_LITERAL_REF;
}

// ---------------------------------------------------------------------------
// Java properties
// ---------------------------------------------------------------------------

/**
 * A Java `.properties` file as an ordered list of entries.
 *
 * SUBSET (documented limits): `key=value` and `key:value`, `#`/`!` comment
 * lines, leading whitespace, and a trailing `\` line continuation. Unicode
 * `\uXXXX` escapes and `\:`/`\=` escapes inside KEYS are not decoded — a key
 * that needs them is reported as unread rather than half-read.
 *
 * @param {string} text
 * @param {Object[]|null} [diagnostics]
 * @param {string} [filePath]  for the diagnostics
 * @returns {{key:string, value:string, line:number}[]}
 */
export function parseProperties(text, diagnostics = null, filePath = '') {
  const out = [];
  const unreadable = [];
  const lines = String(text ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    let raw = lines[i];
    const lineNo = i + 1;
    if (/^\s*$/.test(raw) || /^\s*[#!]/.test(raw)) continue;
    // Line continuation: a trailing backslash joins the next physical line.
    while (/\\$/.test(raw) && !/\\\\$/.test(raw) && i + 1 < lines.length) {
      i += 1;
      raw = raw.slice(0, -1) + lines[i].replace(/^\s+/, '');
    }
    const m = /^\s*([^=:\s]+)\s*[=:]\s*(.*)$/.exec(raw);
    if (!m) { unreadable.push(lineNo); continue; }
    if (/\\[uU:=]/.test(m[1])) { unreadable.push(lineNo); continue; }
    out.push({ key: m[1], value: m[2].trim(), line: lineNo });
  }
  // ONE diagnostic per FILE, not one per line — and only for a file that holds a
  // datasource key at all. The per-line form made `cascade init` on jeecg-boot
  // print 208 identical entries about one PDF.js locale bundle, which is not a
  // gap in the analysis: it drowned the two diagnostics that were.
  if (unreadable.length > 0 && holdsDatasourceKey(out)) {
    diag(diagnostics, 'info', 'UNREADABLE_PROPERTY_LINE', filePath,
      `${unreadable.length} line(s) are not \`key=value\` pairs (or carry a backslash escape this reader does not decode) and were skipped: `
      + `line${unreadable.length === 1 ? '' : 's'} ${unreadable.slice(0, UNREADABLE_LINES_NAMED).join(', ')}`
      + (unreadable.length > UNREADABLE_LINES_NAMED ? `, and ${unreadable.length - UNREADABLE_LINES_NAMED} more` : ''));
  }
  return out;
}

/** How many skipped line numbers the one-per-file diagnostic names inline. */
const UNREADABLE_LINES_NAMED = 5;

// ---------------------------------------------------------------------------
// dotenv
// ---------------------------------------------------------------------------

/**
 * A `.env` file as entries. SUBSET: `KEY=value`, an optional `export ` prefix,
 * `#` comment lines and trailing ` #` comments on unquoted values, single- or
 * double-quoted values (the quotes are stripped, no escape decoding). `${VAR}`
 * placeholders are KEPT AS TEXT — this reader never consults `process.env`.
 * @param {string} text
 * @param {Object[]|null} [diagnostics]
 * @param {string} [filePath]
 * @returns {{key:string, value:string, line:number}[]}
 */
export function parseDotenv(text, diagnostics = null, filePath = '') {
  const out = [];
  const lines = String(text ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (/^\s*$/.test(raw) || /^\s*#/.test(raw)) continue;
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)$/.exec(raw);
    if (!m) {
      diag(diagnostics, 'info', 'UNREADABLE_ENV_LINE', filePath,
        `line ${i + 1} is not a \`KEY=value\` pair and was skipped`);
      continue;
    }
    let value = m[2];
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    out.push({ key: m[1], value, line: i + 1 });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The minimal `spring: datasource:` YAML reader
// ---------------------------------------------------------------------------

/**
 * Read the `spring: datasource:` subtree of a YAML file — and nothing else.
 *
 * A thin wrapper over `readYamlLeaves` (the ONE walker in this engine), pinned
 * to the datasource subtree, with sequences refused: a datasource is a mapping,
 * and a `- item` under it is a shape this reader will not guess at.
 *
 * @param {string} text
 * @param {Object[]|null} [diagnostics]
 * @param {string} [filePath]
 * @returns {{doc:number, keyPath:string[], value:(string|null), line:number}[]}
 *          leaves under `spring.datasource`, `keyPath` RELATIVE to it
 */
export function readSpringDatasourceYaml(text, diagnostics = null, filePath = '') {
  return readYamlLeaves(text, {
    interest: (keys) => keys.length >= 2 && keys[0] === 'spring' && keys[1] === 'datasource',
    sequences: false,
    diagnostics,
    filePath,
  }).map((l) => ({ ...l, keyPath: l.keyPath.slice(2) }));
}

/**
 * EVERY LEAF OF A YAML FILE THAT THE CALLER IS INTERESTED IN.
 *
 * THIS IS NOT A YAML PARSER, and it must not grow into one (SPEC §4: the engine
 * ships zero runtime dependencies). It understands exactly:
 *
 *   - block mappings nested by SPACE indentation (`key:` then indented children);
 *   - scalar values on the key's own line (`url: jdbc:mysql://…`);
 *   - plain, single-quoted and double-quoted scalars (quotes stripped; `''`
 *     inside single quotes, and `\\`/`\"`/`\n`/`\t` inside double quotes);
 *   - `#` comments — a whole-line one, or one after whitespace outside quotes;
 *   - multiple documents separated by `---` (each is read independently, and a
 *     leaf carries the document index it came from);
 *   - with `sequences: true`, block sequences (`- item`, `- key: value`) and a
 *     ONE-LEVEL flow sequence of scalars (`[a, b]`). A sequence entry takes the
 *     index it has in the file as its key path segment (a NUMBER, so a caller
 *     can tell `routes.0.uri` from a mapping key spelled `0`).
 *
 * Everything else INSIDE THE REGION OF INTEREST — flow mappings (`{a: b}`),
 * nested flow collections, block scalars (`|`, `>`), anchors/aliases/merge keys
 * (`&a`, `*a`, `<<:`), tab indentation, and sequences when the caller did not
 * ask for them — is refused with an `UNSUPPORTED_YAML` diagnostic and the line
 * is skipped. Outside that region everything is ignored WITHOUT comment,
 * because it is none of this reader's business.
 *
 * @param {string} text
 * @param {{interest?:(keys:(string|number)[]) => boolean, sequences?:boolean,
 *          diagnostics?:(Object[]|null), filePath?:string}} [opts]
 *        `interest` is asked about a FULL key path (the file's own, not
 *        relative to anything) and decides both which leaves come back and
 *        which lines are worth a diagnostic. Omitted, everything is of interest.
 * @returns {{doc:number, keyPath:(string|number)[], value:(string|null), line:number}[]}
 */
/**
 * THE READER'S OWN STATE: the leaves found so far, and the frame stack that says
 * where in the document the next line sits.
 *
 * A frame is a mapping key (`kind: 'map'`) or one entry of a block sequence
 * (`kind: 'item'`). `indent` is the column the frame OWNS: a child sits deeper
 * than it, a sibling sits at it.
 */
function yamlReader(opts) {
  const st = {
    interest: typeof opts.interest === 'function' ? opts.interest : () => true,
    sequences: opts.sequences === true,
    diagnostics: opts.diagnostics ?? null,
    filePath: opts.filePath ?? '',
    leaves: [],
    doc: 0,
    /** @type {{kind:string, indent:number, key?:string, index?:number, line:number, hadChild:boolean, seq?:number}[]} */
    stack: [],
  };
  st.pathOf = () => st.stack.map((f) => (f.kind === 'item' ? f.index : f.key));
  // A `key:` with no value is a mapping node UNTIL the indentation proves it had
  // no children; only then is it an empty scalar (`password:` = no password).
  st.closeNode = (node) => {
    if (node.kind !== 'map' || node.hadChild) return;
    const keys = [...st.pathOf(), node.key];
    if (st.interest(keys)) st.leaves.push({ doc: st.doc, keyPath: keys, value: null, line: node.line });
  };
  st.popTo = (indent) => {
    while (st.stack.length > 0 && st.stack[st.stack.length - 1].indent >= indent) {
      st.closeNode(st.stack.pop());
    }
  };
  st.endDoc = () => { st.popTo(-1); st.stack = []; };
  st.warn = (lineNo, why) => diag(st.diagnostics, 'warn', 'UNSUPPORTED_YAML', st.filePath, `line ${lineNo} ${why}`);
  return st;
}

/** One `key: value` (or `key:`) entry, at the column it was written in. */
function yamlMapEntry(st, content, indent, lineNo) {
  const here = st.pathOf();
  const split = splitYamlKey(content);
  if (!split) {
    if (st.interest(here)) st.warn(lineNo, `under ${here.join('.')} is not a \`key: value\` mapping entry; it was skipped`);
    return;
  }
  const { key, value } = split;
  if (st.stack.length > 0) st.stack[st.stack.length - 1].hadChild = true;

  if (value === '') {
    st.stack.push({ kind: 'map', indent, key, line: lineNo, hadChild: false, seq: 0 });
    return;
  }

  const keys = [...here, key];
  if (!st.interest(keys)) return;

  // A flow SEQUENCE of scalars is the one flow collection this reader reads, and
  // only when the caller asked for sequences: `predicates: [Path=/a/**]` is how
  // half the Spring documentation spells a list. A nested one, or a flow
  // mapping, is still refused rather than half-read.
  if (st.sequences && value.startsWith('[') && value.endsWith(']')
    && !/[[{]/.test(value.slice(1, -1))) {
    splitFlowScalars(value.slice(1, -1)).forEach((item, index) => {
      st.leaves.push({ doc: st.doc, keyPath: [...keys, index], value: unquoteYaml(item), line: lineNo });
    });
    return;
  }

  if (/^[|>&*!]/.test(value) || value.startsWith('{') || value.startsWith('[') || key === '<<') {
    st.warn(lineNo, `(${keys.join('.')}) uses a YAML construct this reader does not interpret (block scalar, flow collection, anchor/alias or merge key); it was skipped rather than guessed`);
    return;
  }
  st.leaves.push({ doc: st.doc, keyPath: keys, value: unquoteYaml(value), line: lineNo });
}

/**
 * One entry of a BLOCK SEQUENCE, `- …`.
 *
 * A dash may sit at its parent key's own column (YAML allows both), so a frame
 * AT this column is popped only when it is a sibling entry of the same sequence
 * rather than the mapping key that owns it.
 */
function yamlSequenceEntry(st, content, indent, lineNo) {
  if (!st.sequences) {
    st.popTo(indent);
    const here = st.pathOf();
    if (st.interest(here)) st.warn(lineNo, `starts a sequence under ${here.join('.')}; this reader reads block mappings only, so the entry was skipped`);
    return;
  }
  st.popTo(indent + 1);
  while (st.stack.length > 0 && st.stack[st.stack.length - 1].kind === 'item'
    && st.stack[st.stack.length - 1].indent === indent) {
    st.closeNode(st.stack.pop());
  }
  const owner = st.stack.length > 0 ? st.stack[st.stack.length - 1] : null;
  if (!owner || owner.kind !== 'map') {
    if (st.interest(st.pathOf())) st.warn(lineNo, 'starts a sequence that belongs to no mapping key; it was skipped');
    return;
  }
  owner.hadChild = true;
  const index = owner.seq ?? 0;
  owner.seq = index + 1;
  const rest = content === '-' ? '' : content.slice(2).trim();
  st.stack.push({ kind: 'item', indent, index, line: lineNo, hadChild: rest !== '', seq: 0 });
  if (rest === '') return;
  // `- key: value` on one line: the entry's first mapping key, at the column it
  // really occupies, so its own children line up under it.
  const inlineIndent = indent + (content.length - content.slice(2).length)
    + (content.slice(2).length - content.slice(2).trimStart().length);
  if (splitYamlKey(rest)) { yamlMapEntry(st, rest, inlineIndent, lineNo); return; }
  // `- StripPrefix=2`: a scalar entry of the list.
  const keys = st.pathOf();
  if (st.interest(keys)) st.leaves.push({ doc: st.doc, keyPath: keys, value: unquoteYaml(rest), line: lineNo });
}

export function readYamlLeaves(text, opts = {}) {
  const st = yamlReader(opts);
  const lines = String(text ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const lineNo = i + 1;
    if (/^\s*$/.test(raw)) continue;
    if (/^\s*#/.test(raw)) continue;
    if (/^---\s*$/.test(raw) || /^---\s+/.test(raw)) { st.endDoc(); st.doc += 1; continue; }
    if (/^\.\.\.\s*$/.test(raw)) { st.endDoc(); continue; }

    const indentMatch = /^[ \t]*/.exec(raw)[0];
    const content = stripYamlComment(raw.slice(indentMatch.length));
    if (content === '') continue;
    const indent = indentMatch.length;

    if (indentMatch.includes('\t')) {
      // Only complain when it could concern us; a tab elsewhere is not our file.
      if (st.interest(st.pathOf())) st.warn(lineNo, 'is indented with a tab, which YAML forbids and this reader does not interpret; the line was skipped');
      continue;
    }

    if (content.startsWith('- ') || content === '-') {
      yamlSequenceEntry(st, content, indent, lineNo);
      continue;
    }

    st.popTo(indent);
    yamlMapEntry(st, content, indent, lineNo);
  }
  st.endDoc();
  return st.leaves;
}

/** `a, b, "c, d"` split on the commas OUTSIDE quotes, trimmed, blanks dropped. */
function splitFlowScalars(body) {
  const out = [];
  let cur = '';
  let quote = null;
  for (const c of String(body ?? '')) {
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === ',') { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  out.push(cur.trim());
  return out.filter((s) => s !== '');
}

/** Remove a trailing `#` comment that sits outside quotes (YAML needs a space
 * before it, which is what keeps `jdbc:mysql://h/db?x=1#y` intact). */
function stripYamlComment(s) {
  let quote = null;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).trimEnd();
  }
  return s.trimEnd();
}

/** `key: value` split at the first `:` that is followed by a space or ends the
 * line, honouring quoted keys. Returns null when the line is not a mapping. */
function splitYamlKey(s) {
  let quote = null;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === ':' && (i + 1 >= s.length || /\s/.test(s[i + 1]))) {
      const key = unquoteYaml(s.slice(0, i).trim());
      if (key === '') return null;
      return { key, value: s.slice(i + 1).trim() };
    }
  }
  return null;
}

/** Strip YAML quoting from a scalar (see `readSpringDatasourceYaml` limits). */
function unquoteYaml(s) {
  const text = String(s ?? '');
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).split("''").join("'");
  }
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1)
      .replace(/\\n/g, '\n').replace(/\\t/g, '\t')
      .replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return text;
}

// ---------------------------------------------------------------------------
// Per-format candidate assembly
// ---------------------------------------------------------------------------

/**
 * Group `{dottedPrefix, lastKey}` entries into candidates: every group that
 * holds a URL becomes one, and takes its user/password from the same group —
 * or, for a nested group such as `hikari` (Spring's own inheritance), from the
 * root group when it has none of its own.
 */
function candidatesFromGroups(entries, { filePath, kind }) {
  const groups = new Map(); // groupKey -> {url, urlRaw, user, password}
  const groupOf = (key) => {
    const parts = key.split('.');
    return { group: parts.slice(0, -1).join('.'), last: norm(parts[parts.length - 1]) };
  };
  for (const e of entries) {
    const { group, last } = groupOf(e.key);
    if (!groups.has(group)) groups.set(group, {});
    const g = groups.get(group);
    if (URL_KEYS.has(last) && URL_LIKE_RE.test(e.value)) g.url = e.value;
    else if (USER_KEYS.has(last)) g.user = e.value;
    else if (PASSWORD_KEYS.has(last)) g.password = e.value;
  }
  const out = [];
  for (const [group, g] of [...groups].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    if (!g.url) continue;
    let user = g.user;
    let password = g.password;
    // Spring resolves `spring.datasource.hikari.jdbc-url` against the shared
    // `spring.datasource.username`/`password`; mirror that ONE inheritance step.
    if (user === undefined || password === undefined) {
      const parent = groups.get(parentGroup(group));
      if (parent) {
        if (user === undefined) user = parent.user;
        if (password === undefined) password = parent.password;
      }
    }
    out.push(makeCandidate({
      filePath,
      kind,
      url: g.url,
      user,
      password,
    }));
  }
  return out;
}

function parentGroup(group) {
  const parts = String(group ?? '').split('.').filter(Boolean);
  return parts.slice(0, -1).join('.');
}

function makeCandidate({ filePath, kind, url, user, password }) {
  const parsed = parseConnectionUrl(url) ?? {
    url: redactUrl(url), host: null, port: null, database: null, dialect: null,
    usernameRef: null, passwordPresent: false, passwordRef: null, notes: [],
  };
  const hasPassword = typeof password === 'string' && password.trim() !== '';
  return {
    path: filePath,
    kind,
    url: parsed.url,
    host: parsed.host,
    port: parsed.port,
    database: parsed.database,
    dialect: parsed.dialect,
    usernameRef: typeof user === 'string' && user.trim() !== '' ? user.trim() : parsed.usernameRef,
    passwordPresent: hasPassword || parsed.passwordPresent,
    passwordRef: hasPassword ? refFor(password) : parsed.passwordRef,
  };
}

function fromYaml(file, diagnostics) {
  const leaves = readSpringDatasourceYaml(file.text, diagnostics, file.path);
  // One `---` document is one configuration (Spring's own multi-profile file
  // shape), so the documents are grouped SEPARATELY: a `prod` document must not
  // overwrite the `dev` one and leave the user looking at half a list.
  const byDoc = new Map();
  for (const l of leaves) {
    if (typeof l.value !== 'string') continue;
    if (!byDoc.has(l.doc)) byDoc.set(l.doc, []);
    byDoc.get(l.doc).push({ key: l.keyPath.join('.'), value: l.value });
  }
  const out = [];
  for (const doc of [...byDoc.keys()].sort((a, b) => a - b)) {
    out.push(...candidatesFromGroups(byDoc.get(doc), { filePath: file.path, kind: 'spring-yml' }));
  }
  return out;
}

function fromProperties(file, diagnostics) {
  const entries = parseProperties(file.text, diagnostics, file.path);
  const spring = entries
    .filter((e) => e.key.toLowerCase().startsWith('spring.datasource.'))
    .map((e) => ({ key: e.key.slice('spring.datasource.'.length), value: e.value }));
  if (spring.length > 0) {
    const found = candidatesFromGroups(spring, { filePath: file.path, kind: 'spring-properties' });
    if (found.length > 0) return found;
  }
  // No Spring datasource in this properties file — but a MyBatis-generator or
  // hand-rolled `jdbc.connectionURL` is still a connection candidate, and
  // pretending not to see it would hide exactly what the user is looking for.
  return candidatesFromGroups(
    entries.map((e) => ({ key: e.key, value: e.value })),
    { filePath: file.path, kind: 'jdbc-url' },
  );
}

function fromDotenv(file, diagnostics) {
  const entries = parseDotenv(file.text, diagnostics, file.path);
  const byKey = new Map(entries.map((e) => [e.key.toUpperCase(), e.value]));
  const pick = (keys) => {
    for (const k of keys) {
      const v = byKey.get(k);
      if (typeof v === 'string' && v.trim() !== '') return v;
    }
    return undefined;
  };
  const url = pick(ENV_URL_KEYS);
  if (url === undefined || !URL_LIKE_RE.test(url)) return [];
  return [makeCandidate({
    filePath: file.path,
    kind: 'dotenv',
    url,
    user: pick(ENV_USER_KEYS),
    password: pick(ENV_PASSWORD_KEYS),
  })];
}

// A bare URL in any other file (the `DataSource` bean case). Only the URL is
// read: a password sitting on some neighbouring line is not something this
// reader can attribute, so it is not claimed.
function fromLooseText(file, _diagnostics) {
  const seen = new Set();
  const out = [];
  const re = /(jdbc:[A-Za-z0-9+:]+:(?:@?\/\/|@)[^\s"'`,)]+|jdbc:oracle:[A-Za-z]+:@[^\s"'`,)]+|(?:mysql|mariadb|postgres|postgresql):\/\/[^\s"'`,)]+)/g;
  for (const m of String(file.text ?? '').matchAll(re)) {
    const url = m[1].replace(/[.,;]+$/, '');
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(makeCandidate({ filePath: file.path, kind: 'jdbc-url', url, user: undefined, password: undefined }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Presentation (shared by `cascade catalog discover` and `cascade catalog fetch`)
// ---------------------------------------------------------------------------

/**
 * The one-line, redacted description of a candidate. This is the string the
 * user is shown before anything connects (§12.3), so it must be complete enough
 * to recognize the target and must never carry a secret.
 * @param {Object} c  a candidate
 * @returns {string}
 */
export function describeCandidate(c) {
  const dialect = c.dialect ?? 'unknown-dialect';
  const port = c.port ?? (c.dialect ? DEFAULT_PORTS[c.dialect] : null);
  const portText = c.port ?? (port ? `${port} (dialect default)` : '?');
  const target = `${dialect} ${c.host ?? '?'}:${portText}/${c.database ?? '?'}`;
  const user = c.usernameRef ? `user ${c.usernameRef}` : 'user not stated in this file';
  const pw = c.passwordPresent ? `password present (${c.passwordRef})` : 'no password in this file';
  return `${target}: ${user}, ${pw}`;
}

// ---------------------------------------------------------------------------

function diag(list, severity, kind, filePath, reason) {
  if (Array.isArray(list)) list.push({ kind, severity, path: filePath, reason });
}

export class DbConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DbConfigError';
  }
}
