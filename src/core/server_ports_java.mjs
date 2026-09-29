// server_ports_java.mjs — what a Java or Kotlin source says about its
// application's port (discovery reads a `.kt` file for this and nothing else).
//
// WHY. The port an application listens on is written in its configuration
// files (src/core/server_ports.mjs), and CODE can say otherwise (review 3, R8
// and N7): a `WebServerFactoryCustomizer` that calls `setPort(9090)`,
// `SpringApplication.setDefaultProperties(Map.of("server.port", "9090"))`, a
// builder handed `"server.port=9090"`, a `@PropertySource` that loads a file of
// its own. Each of those is read here, as a record for the application the
// source belongs to, in the same shape a configuration file's record has.
//
// WHAT IS READ, AS DATA. The code is read with its comments taken out, so an
// `@PropertySource` a comment mentions loads nothing. `PORT_SET_IN_CODE` below
// names what sets a port; a hit makes that application's port unknown, with
// the rule's words as the reason. A `@PropertySource` names files: one on the
// classpath is looked for in the tree by the caller (src/core/discover.mjs) and
// read like any configuration file; one outside the classpath, or written with
// a placeholder, is configuration this reader does not follow.
//
// WHICH APPLICATION. The source root `src/main/java` (or `kotlin`) sits beside
// `src/main/resources`, at the top of the repository too: that resources
// directory is the application, the same one its configuration files name.
//
// Pure: a path and a text in, records out.

import path from 'node:path';

/**
 * WHAT SETS A PORT IN CODE, and in which words the reason is given. `text` is
 * matched against the source with its comments taken out; `withAny` names
 * types one of which the source must also mention. The first that matches
 * gives the reason, so the most specific comes first.
 *
 * The key itself is read by default-deny (review 4, W-10): a string that names
 * `server.port` sets it wherever it stands (a map entry past the first, a
 * constant handed on later, a command-line argument), unless what is written
 * right before it is one of the shapes that only READ a property
 * (`readBefore`: `env.getProperty("server.port")`).
 */
export const PORT_SET_IN_CODE = Object.freeze([
  {
    what: 'the port set on the web server factory (setPort)',
    text: /\.setPort\s*\(/,
    withAny: [
      'WebServerFactoryCustomizer', 'ConfigurableWebServerFactory', 'ConfigurableServletWebServerFactory',
      'ConfigurableReactiveWebServerFactory', 'TomcatServletWebServerFactory', 'JettyServletWebServerFactory',
      'UndertowServletWebServerFactory', 'NettyReactiveWebServerFactory', 'TomcatReactiveWebServerFactory',
    ],
  },
  {
    what: 'default properties set on the application in code (setDefaultProperties), which may hold server.port',
    text: /\.setDefaultProperties\s*\(/,
  },
  {
    what: 'server.port named in code other than to read it (a map entry, a system property, a builder argument, a constant)',
    text: /"(?:--|-D)?server\.port(?:=[^"]*)?"/,
    readBefore: /\b(?:getProperty|getRequiredProperty|containsProperty)\s*\(\s*$/,
  },
]);

/** Whether a rule hits the code: a match of its text, with a type it names, and not in a shape that only reads. */
function hits(rule, code) {
  if (rule.withAny && !rule.withAny.some((t) => code.includes(t))) return false;
  if (!rule.readBefore) return rule.text.test(code);
  for (const m of code.matchAll(new RegExp(rule.text.source, 'g'))) {
    if (!rule.readBefore.test(code.slice(Math.max(0, m.index - 80), m.index))) return true;
  }
  return false;
}

/** A Java or Kotlin source with its comments blanked out, and its string and character literals kept. */
export function withoutComments(text) {
  const s = String(text);
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (c === '"' || c === '\'') {
      let j = i + 1;
      while (j < s.length && s[j] !== c && s[j] !== '\n') j += s[j] === '\\' ? 2 : 1;
      out += s.slice(i, j + 1);
      i = j;
    } else if (c === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i += 1;
      out += '\n';
    } else if (c === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      i = end < 0 ? s.length : end + 1;
      out += ' ';
    } else out += c;
  }
  return out;
}

/** The application a Java or Kotlin source belongs to: the resources directory beside its source root. */
export function applicationOfSource(filePath) {
  const f = String(filePath).split('\\').join('/');
  const m = /(^|\/)src\/main\/(?:java|kotlin)\//.exec(f);
  return m ? `${f.slice(0, m.index + m[1].length)}src/main/resources` : path.posix.dirname(f);
}

/** The files each `@PropertySource` / `@PropertySources` names, as written. */
function propertySources(code) {
  const out = [];
  const re = /@PropertySources?\s*\(/g;
  for (let m = re.exec(code); m !== null; m = re.exec(code)) {
    let depth = 1;
    let j = re.lastIndex;
    for (; j < code.length && depth > 0; j += 1) depth += code[j] === '(' ? 1 : code[j] === ')' ? -1 : 0;
    for (const s of code.slice(re.lastIndex, j).matchAll(/"((?:[^"\\]|\\.)*)"/g)) out.push(s[1]);
  }
  return out;
}

/** One file a `@PropertySource` names, as a classpath resource to look for, or null when it cannot be followed. */
function resourceOf(spec) {
  if (spec.includes('${')) return null;
  const m = /^classpath\*?:\/?(.+)$/.exec(spec);
  if (m) return m[1];
  return /^[a-z]+:/i.test(spec) ? null : spec.replace(/^\//, '');
}

/**
 * THE RECORDS ONE JAVA SOURCE ADDS to its application, once the files its
 * `@PropertySource` names are looked for in the tree (`readTree`, a path
 * relative to the root, null when there is none): each one found is read as
 * a configuration file of that application (`readConfig`), and adds a record
 * only when it says something about the port; one not found, or code that
 * sets the port, makes the application's port unknown.
 */
export function portRecordsOfJava(rec, readTree, readConfig) {
  const out = [];
  const missing = [];
  for (const r of rec.loads) {
    const where = `${rec.app}/${r}`;
    const text = readTree(where);
    if (text === null) { missing.push(r); continue; }
    const one = readConfig({ path: where, text });
    if (one.ports.length > 0 || one.unreadable.length > 0 || one.external) out.push({ ...one, app: rec.app });
  }
  const external = rec.external || (missing.length > 0 ? `@PropertySource(classpath:${missing.join(', classpath:')}), a file not in this tree` : false);
  if (external) out.push({ file: rec.file, app: rec.app, ports: [], unreadable: [], external });
  return out;
}

/**
 * WHAT ONE JAVA SOURCE SAYS ABOUT ITS APPLICATION'S PORT: a record whose port
 * is unknown (`external`) when code sets it or loads configuration that cannot
 * be followed, and the classpath files a `@PropertySource` names (`loads`),
 * which the caller reads from the tree.
 * @returns {{file:string, app:string, ports:[], unreadable:[], external:(string|false), loads:string[]}|null}
 */
export function serverPortsOfJava(filePath, text) {
  const code = withoutComments(text);
  const rule = PORT_SET_IN_CODE.find((r) => hits(r, code));
  const specs = propertySources(code);
  if (!rule && specs.length === 0) return null;
  const unfollowed = specs.filter((s) => resourceOf(s) === null);
  const external = rule ? rule.what : unfollowed.length > 0 ? `@PropertySource(${unfollowed.join(', ')})` : false;
  return {
    file: filePath, app: applicationOfSource(filePath), ports: [], unreadable: [], external,
    loads: specs.map(resourceOf).filter((r) => r !== null),
  };
}
