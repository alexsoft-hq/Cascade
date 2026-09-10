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
const INTEREST_RE = /^spring\.(?:application|config|cloud\.gateway|thymeleaf|freemarker|velocity|mvc\.view)(?:\.|$)/;

/**
 * THE VIEW RESOLVERS, and what each one calls its prefix and its suffix.
 *
 * A server-rendered page is found by joining a prefix, the view name a handler
 * returned, and a suffix. Each engine spells the first two its own way and
 * documents its own defaults; both are here, because a project that sets
 * neither still has a template root and a suffix, and the default is what runs.
 *
 * `spring.mvc.view.*` is Spring MVC's own resolver rather than an engine's, so
 * it is read as the JSP one: that is the resolver a JSP application configures.
 */
export const VIEW_RESOLVERS = Object.freeze([
  { engine: 'thymeleaf', prefixKeys: ['spring.thymeleaf.prefix'], suffixKeys: ['spring.thymeleaf.suffix'], markerKey: 'spring.thymeleaf', defaultPrefix: 'classpath:/templates/', defaultSuffix: '.html' },
  { engine: 'freemarker', prefixKeys: ['spring.freemarker.template-loader-path', 'spring.freemarker.prefix'], suffixKeys: ['spring.freemarker.suffix'], markerKey: 'spring.freemarker', defaultPrefix: 'classpath:/templates/', defaultSuffix: '.ftl' },
  { engine: 'jsp', prefixKeys: ['spring.mvc.view.prefix'], suffixKeys: ['spring.mvc.view.suffix'], markerKey: 'spring.mvc.view', defaultPrefix: null, defaultSuffix: '.jsp' },
  { engine: 'velocity', prefixKeys: ['spring.velocity.resource-loader-path', 'spring.velocity.prefix'], suffixKeys: ['spring.velocity.suffix'], markerKey: 'spring.velocity', defaultPrefix: 'classpath:/templates/', defaultSuffix: '.vm' },
]);

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

/**
 * The replacement that goes with it: literal characters and one reference.
 *
 * THE BACKSLASHES ARE SPRING'S OWN SPELLING, not a typo. Spring resolves
 * `${…}` in a configuration value as a property placeholder before the gateway
 * ever sees it, so the reference has to be written `$\{segment}` for the
 * gateway to get it — which is exactly what the Spring Cloud Gateway reference
 * tells YAML authors to write. A value that has been through one more level of
 * quoting arrives as `$\\{segment}`. All three spellings mean the one capture
 * group, so all three are read as it.
 */
const PLAIN_REPLACEMENT_RE = /^([A-Za-z0-9._~/-]*)(?:\$\\{0,2}\{([A-Za-z][A-Za-z0-9]*)\}|\$(\d))([A-Za-z0-9._~/-]*)$/;

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
 * A key in ONE spelling. Spring's relaxed binding accepts
 * `spring.freemarker.templateLoaderPath`, `...template-loader-path` and
 * `...TEMPLATE_LOADER_PATH` for the same property, and a project that wrote one
 * of them must not be read as having written nothing.
 * @param {string} key
 * @returns {string}
 */
export function relaxedKey(key) {
  return String(key ?? '')
    .replace(/_/g, '-')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase();
}

/**
 * The view resolver settings each file declares, one entry per engine per file.
 *
 * Only what is WRITTEN: the defaults belong to whoever joins these onto a tree
 * (src/core/discover.mjs), because a default only means something once there is
 * a directory to test it against.
 *
 * @param {{path:string, text:string}[]} files
 * @param {Object[]|null} [diagnostics]
 * @returns {{engine:string, prefix:(string|null), suffix:(string|null), file:string, line:number}[]}
 *          sorted by engine, then file
 */
export function findViewResolvers(files, diagnostics = null) {
  const out = [];
  for (const file of files ?? []) {
    if (!file || typeof file.path !== 'string' || typeof file.text !== 'string') continue;
    const byEngine = new Map();
    for (const e of springConfigEntries(file, diagnostics)) {
      // `template-loader-path` may be a LIST; the first entry is the one a view
      // name is resolved against first, and it is the one read here.
      const key = relaxedKey(normalizeKey(e.key)).replace(/\.(\d+)$/, (m, n) => (n === '0' ? '' : m));
      for (const r of VIEW_RESOLVERS) {
        const isPrefix = r.prefixKeys.includes(key);
        const isSuffix = r.suffixKeys.includes(key);
        const isMarker = key === r.markerKey || key.startsWith(`${r.markerKey}.`);
        if (!isPrefix && !isSuffix && !isMarker) continue;
        if (!byEngine.has(r.engine)) {
          byEngine.set(r.engine, { engine: r.engine, prefix: null, suffix: null, file: file.path, line: e.line });
        }
        const hit = byEngine.get(r.engine);
        const value = resolvePlaceholder(e.value);
        if (isPrefix && hit.prefix === null && value !== null) { hit.prefix = value; hit.line = e.line; }
        if (isSuffix && hit.suffix === null && value !== null) { hit.suffix = value; }
      }
    }
    for (const hit of byEngine.values()) out.push(hit);
  }
  out.sort((a, b) => cmp(a.engine, b.engine) || cmp(a.file, b.file));
  return out;
}

// ---- the same question asked of a Spring XML (RM55) ------------------------
//
// WHY THIS IS HERE AND NOT BESIDE THE YAML READER. A Spring Boot project writes
// `spring.mvc.view.prefix` in `application.yml`; a Spring MVC project written
// before Boot — which is what eGovFrame is, and what most of the Korean public
// sector runs — writes the SAME setting as a bean:
//
//   <bean class="org.springframework.web.servlet.view.UrlBasedViewResolver"
//         p:viewClass="…JstlView" p:prefix="/WEB-INF/jsp/" p:suffix=".jsp"/>
//
// Measured before this reader existed: egovframe-enterprise-business-template
// ships 92 JSPs and produced 0 screens, and egovframe-common-components ships
// 747 and produced 1, because nothing in the run could see that prefix. The
// resolver is the same resolver and the answer is the same answer; only the
// spelling is different, so it comes out of here in the same record shape and
// `templateRootsOf` never learns there were two spellings.
//
// WHAT IT REFUSES TO DO. It reads bean ELEMENTS and their properties, and it
// resolves nothing: a `${…}` prefix is a value this tree does not carry, an
// `<import>` is not followed, and a profile-conditional bean is read like any
// other. It is a reader, not a container.

/** A file whose root element is a Spring `<beans>` document. */
const SPRING_BEANS_RE = /<(?:\w+:)?beans[\s>]/;

/** How much of a file is read to decide it is one. */
const SPRING_BEANS_HEAD = 4096;

/**
 * The view classes and resolver classes that name an ENGINE. Asked of the
 * resolver's own class and of the `viewClass` it is given, in that order; a
 * resolver whose suffix names a template extension is answered by the suffix
 * first, because that is the project stating the file type outright.
 */
const XML_VIEW_ENGINE_MARKERS = Object.freeze([
  ['thymeleaf', ['Thymeleaf']],
  ['freemarker', ['FreeMarker', 'Freemarker']],
  ['velocity', ['Velocity']],
  // Spring's own resolvers render a servlet resource, which is a JSP in every
  // project that configures one. `JstlView` and `InternalResourceView` are the
  // two view classes that say so outright.
  ['jsp', ['JstlView', 'InternalResourceView', 'InternalResourceViewResolver', 'UrlBasedViewResolver']],
]);

/** suffix -> engine, for the case where the project simply wrote the extension. */
const XML_VIEW_SUFFIX_ENGINE = Object.freeze({
  '.jsp': 'jsp', '.jspx': 'jsp', '.ftl': 'freemarker', '.ftlh': 'freemarker', '.vm': 'velocity', '.html': 'thymeleaf',
});

/** Whether this text is a Spring bean-definition XML. */
export function looksLikeSpringBeansXml(text) {
  return SPRING_BEANS_RE.test(String(text ?? '').slice(0, SPRING_BEANS_HEAD));
}

/** The attributes of one start tag, as a map. Values are XML-unescaped. */
function attributesOf(tagText) {
  const out = new Map();
  const re = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(tagText)) !== null) out.set(m[1], unescapeXml(m[3] ?? m[4] ?? ''));
  return out;
}

function unescapeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');
}

/**
 * Every `<bean>` element of one document, with the properties it sets.
 *
 * A property is written two ways and both are read: the `p:` attribute
 * shorthand on the element itself, and a `<property name="…" value="…"/>`
 * child. The body of a bean is taken up to its own `</bean>`, counting nested
 * `<bean>` elements so an INNER bean does not end its parent early.
 *
 * @param {string} text
 * @returns {{className:string, id:(string|null), props:Map<string,string>, line:number}[]}
 */
export function springBeansOf(text) {
  // A COMMENTED-OUT BEAN IS NOT A BEAN. Measured on nexacro-sample-egov, whose
  // `dispatcher-servlet.xml` keeps an `InternalResourceViewResolver` inside a
  // comment as an example: read without this, the file declared two resolvers
  // and only one of them exists. Blanked rather than removed, so every line
  // number below still names the line the file really has.
  const body = stripXmlComments(String(text ?? ''));
  const out = [];
  const open = /<(?:\w+:)?bean\b([^>]*?)(\/?)>/g;
  let m;
  while ((m = open.exec(body)) !== null) {
    const attrs = attributesOf(m[1]);
    const className = attrs.get('class') ?? '';
    if (className === '') continue;
    const props = new Map();
    for (const [k, v] of attrs) {
      if (k.startsWith('p:')) props.set(k.slice(2).replace(/-ref$/, ''), v);
    }
    if (m[2] !== '/') {
      // The bean's own body, up to the `</bean>` that closes IT.
      const inner = bodyOfBean(body, open.lastIndex);
      for (const p of inner.matchAll(/<(?:\w+:)?property\b([^>]*?)(?:\/>|>)/g)) {
        const pa = attributesOf(p[1]);
        const name = pa.get('name');
        const value = pa.get('value') ?? pa.get('ref');
        if (name && value !== undefined && !props.has(name)) props.set(name, value);
      }
      // A `<property name="x"><list><value>a</value>…` is one property with
      // several values; the FIRST is the one a view name is resolved against
      // first, which is the same rule the YAML reader keeps for a list.
      for (const p of inner.matchAll(/<(?:\w+:)?property\b([^>]*?)>([\s\S]*?)<\/(?:\w+:)?property>/g)) {
        const name = attributesOf(p[1]).get('name');
        if (!name || props.has(name)) continue;
        const first = /<(?:\w+:)?value\s*>([\s\S]*?)<\/(?:\w+:)?value>/.exec(p[2]);
        if (first) props.set(name, unescapeXml(first[1].trim()));
      }
    }
    out.push({ className, id: attrs.get('id') ?? null, props, line: lineAt(body, m.index) });
  }
  return out;
}

/** The text of a bean's body, from just after its start tag to its own `</bean>`. */
function bodyOfBean(body, from) {
  const re = /<(?:\w+:)?bean\b[^>]*?(\/?)>|<\/(?:\w+:)?bean\s*>/g;
  re.lastIndex = from;
  let depth = 0;
  let m;
  while ((m = re.exec(body)) !== null) {
    if (m[0].startsWith('</')) {
      if (depth === 0) return body.slice(from, m.index);
      depth -= 1;
      continue;
    }
    if (m[1] !== '/') depth += 1;
  }
  return body.slice(from);
}

/** Every `<!-- … -->` blanked to spaces, newlines kept, so line numbers hold. */
function stripXmlComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
}

/** Which line an offset is on (1-based). */
function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

/**
 * The view resolvers a Spring bean XML declares, in the SAME record shape the
 * YAML/properties reader returns, so `templateRootsOf` reads one list.
 *
 * A resolver with neither a prefix nor a suffix (a `BeanNameViewResolver`, a
 * `ContentNegotiatingViewResolver`) resolves a view name against beans rather
 * than against a directory, so it names no template root and yields no record.
 *
 * @param {{path:string, text:string}[]} files
 * @returns {{engine:string, prefix:(string|null), suffix:(string|null), file:string, line:number,
 *            className:string, order:(number|null)}[]} sorted by engine, then order, then file
 */
export function findXmlViewResolvers(files) {
  const out = [];
  for (const file of files ?? []) {
    if (!file || typeof file.path !== 'string' || typeof file.text !== 'string') continue;
    if (!looksLikeSpringBeansXml(file.text)) continue;
    for (const bean of springBeansOf(file.text)) {
      if (!/ViewResolver$/.test(bean.className)) continue;
      const prefix = bean.props.get('prefix') ?? null;
      const suffix = bean.props.get('suffix') ?? null;
      if (prefix === null && suffix === null) continue;
      const engine = xmlViewEngineOf(bean, suffix);
      if (engine === null) continue;
      const order = Number(bean.props.get('order'));
      out.push({
        engine,
        prefix,
        suffix,
        file: file.path,
        line: bean.line,
        className: bean.className,
        order: Number.isInteger(order) ? order : null,
      });
    }
  }
  out.sort((a, b) => cmp(a.engine, b.engine)
    || ((a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER))
    || cmp(a.file, b.file) || (a.line - b.line));
  return out;
}

/** Which engine one resolver bean renders with: its suffix first, then its classes. */
function xmlViewEngineOf(bean, suffix) {
  const bySuffix = suffix === null ? undefined : XML_VIEW_SUFFIX_ENGINE[String(suffix).toLowerCase()];
  if (bySuffix !== undefined) return bySuffix;
  const names = `${bean.className} ${bean.props.get('viewClass') ?? ''}`;
  for (const [engine, markers] of XML_VIEW_ENGINE_MARKERS) {
    if (markers.some((marker) => names.includes(marker))) return engine;
  }
  return null;
}

/**
 * A PROPERTY THAT NAMES THE DATABASE VENDOR ITSELF (RM55).
 *
 * A repository that ships its schema for seven databases has to say somewhere
 * which one it runs on, and it is not the jdbc url: the url is commented out
 * six times over and live once. eGovFrame writes `Globals.DbType = mysql` in
 * `globals.properties`, and the same idea is spelled `db.type`, `database.type`
 * and `db.dialect` elsewhere. This reads the KEY SHAPE — a key whose last
 * segment says "which database" — and not one project's spelling.
 *
 * The value must be a vendor this engine can route; anything else is somebody's
 * own word for a product and is left alone rather than guessed at.
 */
const DB_TYPE_KEY_RE = /(^|\.)(?:db-?type|database-?type|db-?dialect|dbms(?:-?type)?)$/;

/** Spellings of a vendor that mean one of `SQL_DIALECT_ALIASES`' names. */
const DB_TYPE_SPELLINGS = Object.freeze({
  hsql: 'hsqldb', maria: 'mariadb', postgre: 'postgres', pgsql: 'postgres',
  mssql: 'sqlserver', 'ms-sql': 'sqlserver', oracle11g: 'oracle-11g', oracle19c: 'oracle-19c',
});

/**
 * Every `…DbType`-shaped declaration a set of configuration files makes.
 *
 * @param {{path:string, text:string}[]} files
 * @param {(name:string)=>boolean} routable  whether a vendor name is one the engine routes
 * @returns {{vendor:string, key:string, file:string, line:number}[]} sorted by file, then line
 */
export function findDbTypeDeclarations(files, routable = () => true) {
  const out = [];
  for (const file of files ?? []) {
    if (!file || typeof file.path !== 'string' || typeof file.text !== 'string') continue;
    const base = path.posix.basename(file.path.split('\\').join('/')).toLowerCase();
    const entries = base.endsWith('.properties')
      ? parseProperties(file.text, null, file.path).map((e) => ({ key: e.key, value: e.value, line: e.line }))
      : readYamlLeaves(file.text, { sequences: false })
        .filter((l) => typeof l.value === 'string')
        .map((l) => ({ key: l.keyPath.map(String).join('.'), value: l.value, line: l.line }));
    for (const e of entries) {
      if (!DB_TYPE_KEY_RE.test(relaxedKey(String(e.key ?? '')))) continue;
      const raw = resolvePlaceholder(e.value);
      if (raw === null) continue;
      const spelled = String(raw).trim().toLowerCase();
      const vendor = Object.hasOwn(DB_TYPE_SPELLINGS, spelled) ? DB_TYPE_SPELLINGS[spelled] : spelled;
      if (vendor === '' || !routable(vendor)) continue;
      out.push({ vendor, key: String(e.key), file: file.path, line: e.line });
    }
  }
  out.sort((a, b) => cmp(a.file, b.file) || (a.line - b.line));
  return out;
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
    const re = new RegExp(`^${source}$`);
    m = re.exec(front);
    // THE SEPARATOR CAN BE WRITTEN INSIDE THE PATTERN, and in Spring's own
    // example it is: `RewritePath=/portal-service/(?<segment>.*)` puts the
    // slash after the prefix in the regex, so the prefix on its own
    // (`/portal-service`, which is what `Path=/portal-service/**` names) does
    // not match it and everything under it does. Matching the prefix WITH its
    // separator is the same rule read at the same place, and what the group
    // then captures is the empty rest — which is exactly what a prefix rule
    // needs to know.
    if (!m) m = re.exec(`${front}/`);
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
