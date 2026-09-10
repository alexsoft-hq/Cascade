// discover.mjs — fast project discovery for `cascade init` (SPEC §7.3).
//
// Answers "what is this tree, and what can the engine actually read?" in one
// capped walk: repositories (including nested git checkouts), file counts per
// technology, build tool, package prefixes, SQL dialect hint.
//
// SPEC rules honored here:
//  - §7.3: what the engine has NO lane for is never silently ignored — every
//    such finding becomes an `UNSUPPORTED_TECHNOLOGY` diagnostic. A truncated
//    walk says so (`FILE_CAP_REACHED`) instead of pretending it saw everything.
//  - §5: repositories are reported relative to the scanned root ('.' for the
//    root repo); the caller re-bases them onto the manifest file's directory.
//  - §6: nothing here hardcodes a product name or a default package prefix —
//    `packagePrefixes` is measured from the sources.
//
// This module is PURE: every filesystem touch arrives as an injected function
// (`readDir`, `readFile`, `gitHead`), so it is unit-testable on a synthetic tree
// and cannot write anything. `bin/cascade.mjs` supplies the impure versions.

import path from 'node:path';
import { findConnectionCandidates, looksLikeConnectionFile } from './dbconfig.mjs';
import {
  findServiceNames, findGatewayRoutes, findExternalConfigImports, looksLikeSpringConfigFile,
  findViewResolvers, findXmlViewResolvers, findDbTypeDeclarations, looksLikeSpringBeansXml,
} from './springconfig.mjs';
import { SQL_DIALECT_ALIASES } from './profile.mjs';

// Directories that never carry first-party source. Skipped wholesale, so a
// vendored `node_modules` cannot dominate the counts or the file cap.
export const SKIP_DIRS = Object.freeze([
  '.git', 'node_modules', 'target', 'build', 'dist', 'out', '.cascade', '.venv', '.gradle', '.idea',
]);

// Default walk cap. A tree bigger than this is reported as capped: w.capped, never
// silently truncated (§7.3).
export const DEFAULT_MAX_FILES = 50000;

// Share of java files that the reported package prefixes must cover.
const PREFIX_COVERAGE = 0.95;

const SPRING_HANDLER_RE = /@RestController|@Controller|@RequestMapping|@(?:Get|Post|Put|Delete|Patch)Mapping/;
const MYBATIS_MAPPER_RE = /<mapper\s+namespace\s*=/;
const CREATE_TABLE_RE = /create\s+table/i;
const ALTER_TABLE_RE = /alter\s+table/i;
const JPA_ENTITY_RE = /@Entity\b/;
// MyBatis-Plus, in its two unmistakable spellings: the generic mapper every MP
// project extends, and the annotation that names a table. Either one means the
// persistence this project uses is declared in the mapping and in generic CRUD
// rather than written as SQL — the `mybatis-plus` pack's lane (RM15).
const MYBATIS_PLUS_RE = /extends\s+BaseMapper\s*<|@TableName\b/;
const PACKAGE_DECL_RE = /^[ \t]*package[ \t]+([A-Za-z_$][A-Za-z0-9_$]*(?:[ \t]*\.[ \t]*[A-Za-z_$][A-Za-z0-9_$]*)*)[ \t]*;/m;
const FRONTEND_DEPS = Object.freeze(['react', 'vue', 'angular', '@angular/core', 'svelte']);

// An OpenAPI / Swagger document says so in a TOP-LEVEL key, in the first few
// hundred bytes: `openapi: 3.0.1` (or `"openapi": "3.0.1"` in JSON), or the
// Swagger 2 spelling. Only the first 4 KB is examined, so a 2 MB generated
// document is classified without reading it twice, and a file that merely
// mentions the word deeper down is not mistaken for one.
const OPENAPI_HEAD_BYTES = 4096;
// 2 MB. Bigger than that is a generated bundle; the document is reported as a
// candidate this run did NOT read rather than parsed at unbounded cost.
const OPENAPI_MAX_BYTES = 2 * 1024 * 1024;
const OPENAPI_YAML_KEY = /^[ \t]*(openapi|swagger)[ \t]*:/m;
const OPENAPI_JSON_KEY = /"(openapi|swagger)"[ \t]*:/;
// A `paths` section, in either spelling. Only consulted when the file declares
// the key WITHOUT a version this engine recognises: a Spring Boot
// `application.yml` with a `swagger:\n  production: false` block says `swagger`
// and is a configuration file, not a contract. Requiring a version OR a `paths`
// section keeps it out without turning the rule into a parser.
const OPENAPI_PATHS_KEY = /^[ \t]*paths[ \t]*:|"paths"[ \t]*:/m;
const OPENAPI_EXTENSIONS = Object.freeze(['.json', '.yaml', '.yml']);

/**
 * The OpenAPI version a document's head declares: '3', '2', or 'unknown' when it
 * says `openapi`/`swagger` without a version this engine recognises.
 * @param {string} head  the document's first bytes
 * @returns {('3'|'2'|'unknown'|null)} null when the head declares neither key
 */
export function openApiVersionOf(head) {
  const text = String(head ?? '');
  const yaml = OPENAPI_YAML_KEY.test(text);
  const json = OPENAPI_JSON_KEY.test(text);
  if (!yaml && !json) return null;
  if (/["']?openapi["']?[ \t]*:[ \t]*["']?3/.test(text)) return '3';
  if (/["']?swagger["']?[ \t]*:[ \t]*["']?2/.test(text)) return '2';
  return 'unknown';
}

// The web lane's own file list, kept in step with adapters/web/webfacts.mjs.
// `.d.ts` is a type declaration with no code in it, and a test file is a
// different program, so neither is counted as a source the lane will read.
const WEB_EXTENSIONS = Object.freeze(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.vue']);

/**
 * Which framework a frontend package declares, and what it talks to the backend
 * with. Read from the package's own dependencies, never guessed from the code:
 * a package that depends on `vue` is a Vue project because it says so.
 */
const FRAMEWORK_DEPS = Object.freeze([
  ['vue', ['vue']],
  ['react', ['react']],
  ['angular', ['@angular/core', 'angular']],
  ['svelte', ['svelte']],
]);
const ROUTER_DEPS = Object.freeze([
  ['vue-router', ['vue-router']],
  ['react-router', ['react-router', 'react-router-dom']],
  ['angular-router', ['angular-ui-router', '@uirouter/angularjs', 'angular-route']],
]);

/**
 * The registrar spellings that name a router declaration pack IN THE SOURCE.
 *
 * A frontend shipped as `<script>` tags has no dependency list at all, so the
 * table above cannot answer "which router is this?" for it. What the source
 * does carry is the registrar the framework makes you write, and that is the
 * one thing about a vendored frontend that is not a guess. Kept beside
 * ROUTER_DEPS so the two lists name the same packs; test/pack.test.mjs checks
 * every name here against the files in adapters/web/packs.
 */
export const ROUTER_SOURCE_MARKERS = Object.freeze([
  ['angular-router', ['$stateProvider', '$routeProvider', '$urlRouterProvider']],
  ['vue-router', ['createRouter(', 'VueRouter(']],
  ['react-router', ['createBrowserRouter(', 'createHashRouter(', 'createMemoryRouter(']],
]);

/**
 * Directory names that mean "somebody else's code", wherever they sit. A
 * vendored frontend root is never inside one of these: a minified library under
 * `webjars/` is shipped by the build, not written here.
 */
const VENDOR_DIRS = Object.freeze([
  'node_modules', 'bower_components', 'webjars', 'vendor', 'lib', 'dist', 'build', 'target',
]);

/**
 * The same idea, said by NAME rather than by role (RM48): a directory called
 * `plugins`, or called after a library everybody vendors, is somebody else's
 * code wherever it sits. Measured before this list existed: xxl-job had 13
 * vendored frontend roots and 12 of them were one plugin directory each, and
 * jeecg-boot 16 with 12 of the same.
 *
 * MIRRORED from `adapters/web/packs/vendor-dirs.json`, which is the declaration
 * a reader extends; `test/pack.test.mjs` fails if the two disagree. It lives
 * here as a constant because discovery is pure and reads no file of its own.
 */
export const THIRD_PARTY_DIRS = Object.freeze([
  'adminlte', 'bootstrap', 'bootstrap-table', 'bower_components', 'ckeditor',
  'codemirror', 'cron', 'crongen', 'datatables', 'echarts', 'font-awesome',
  'fontawesome', 'fullscreen', 'highcharts', 'jquery', 'jquery-ui', 'laydate',
  'layer', 'layui', 'lib', 'libs', 'moment', 'node_modules', 'nprogress',
  'plugin', 'plugins', 'select2', 'summernote', 'swiper', 'tinymce', 'ueditor',
  'vendor', 'vendors', 'webjars', 'ztree',
]);

const THIRD_PARTY_DIR_SET = new Set(THIRD_PARTY_DIRS);

/**
 * Directory names that mean "this is what the server serves". A `.js` file
 * under one of these is a page's script, not a build helper that happens to sit
 * beside a pom.
 */
const WEB_ROOT_DIRS = Object.freeze(['static', 'public', 'webapp', 'www']);

/** The one two-segment spelling of the same thing (Spring's template directory). */
const WEB_ROOT_PATH = 'resources/templates';

/**
 * THE TEMPLATE ENGINES a server-rendered page can be written in (RM48), by the
 * file extension the engine's own documentation gives it.
 *
 * `plain-html` is not an engine and is not in here: it is what an `.html`
 * template root is called when nothing says Thymeleaf, and the extension it
 * answers to is Thymeleaf's.
 */
export const TEMPLATE_ENGINES = Object.freeze([
  { engine: 'thymeleaf', extensions: ['.html', '.htm'], defaultPrefix: 'templates', defaultSuffix: '.html', markers: ['th:', 'xmlns:th'], underTemplateDirOnly: true },
  { engine: 'freemarker', extensions: ['.ftl', '.ftlh'], defaultPrefix: 'templates', defaultSuffix: '.ftl', markers: [], underTemplateDirOnly: false },
  // Spring MVC's own resolver, which is what a JSP application configures, has
  // NO documented default prefix: `/WEB-INF/jsp/` is a convention and not a
  // default, so a JSP root is the directory the files themselves sit under.
  { engine: 'jsp', extensions: ['.jsp', '.jspx'], defaultPrefix: null, defaultSuffix: '.jsp', markers: [], underTemplateDirOnly: false },
  { engine: 'velocity', extensions: ['.vm'], defaultPrefix: 'templates', defaultSuffix: '.vm', markers: [], underTemplateDirOnly: false },
]);

/**
 * Where an `.html` file is a VIEW rather than a page the server just hands out.
 *
 * An `.html` under `static/` is served as it stands: no handler names it, no
 * resolver renders it, and reading every one of them would cost the run a walk
 * through whatever a project keeps there. A view lives where the resolver looks,
 * and these are the two directory names every Spring layout uses for that.
 */
const TEMPLATE_DIR_SEGMENTS = Object.freeze(['templates', 'WEB-INF']);

/** How many of a template root's own files are read to see which engine wrote them. */
const TEMPLATE_MARKER_FILES = 40;
/** How much of each of those. A `th:` attribute is on the first tag of the page. */
const TEMPLATE_MARKER_BYTES = 8192;

/** How many files of a vendored root are read to see which router it names. */
const ROUTER_SCAN_FILES = 400;
/** How much of each of those files. A registrar is named where the module is set up. */
const ROUTER_SCAN_BYTES = 65536;

/** The router declaration packs this engine ships, in the order they are tried. */
export const ROUTER_PACKS = Object.freeze(ROUTER_DEPS.map(([name]) => name));

/**
 * Which router declaration pack a package's dependencies name, or null.
 *
 * ONE table, read from two places: discovery walks the analyzed tree with it,
 * and `cascade analyze` reads it again for a frontend that lives OUTSIDE that
 * tree, which no walk of the root could ever have seen. Duplicating the list
 * would let the two disagree about the same package.json.
 *
 * @param {Object|null} dependencies  a merged dependencies + devDependencies map
 * @returns {string|null}
 */
export function routerDependencyOf(dependencies) {
  if (!dependencies || typeof dependencies !== 'object') return null;
  const hit = ROUTER_DEPS.find(([, names]) =>
    names.some((n) => Object.prototype.hasOwnProperty.call(dependencies, n)));
  return hit ? hit[0] : null;
}

/**
 * Whether a file name is one the web lane reads. Mirrors the worker's own rule.
 * @param {string} name  a bare file name
 * @returns {boolean}
 */
export function isWebSourceFile(name) {
  const n = String(name ?? '');
  if (n.endsWith('.d.ts')) return false;
  if (n.endsWith('.min.js')) return false;
  if (/\.(?:test|spec)\./.test(n)) return false;
  return WEB_EXTENSIONS.some((e) => n.endsWith(e));
}

/**
 * Whether a root-relative directory could hold a VENDORED frontend: nothing on
 * its path is somebody else's code.
 * @param {string} relDir
 * @returns {boolean}
 */
export function outsideVendorDirs(relDir) {
  const segments = String(relDir ?? '').split('/').filter((s) => s !== '' && s !== '.');
  return !segments.some((s) => VENDOR_DIRS.includes(s) || THIRD_PARTY_DIR_SET.has(s.toLowerCase()));
}

/**
 * Whether a root-relative directory sits where a server serves files from: it
 * IS, or is under, a directory named `static`, `public`, `webapp` or `www`, or
 * it is under `resources/templates`.
 * @param {string} relDir
 * @returns {boolean}
 */
export function underWebRootDir(relDir) {
  const posix = String(relDir ?? '');
  const segments = posix.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.some((s) => WEB_ROOT_DIRS.includes(s))) return true;
  for (let i = 0; i + 1 < segments.length; i += 1) {
    if (`${segments[i]}/${segments[i + 1]}` === WEB_ROOT_PATH) return true;
  }
  return false;
}

/**
 * The DIRECTORY a view name is resolved against, from a configured prefix.
 *
 * `classpath:/templates/` is a location on the class path, `/WEB-INF/jsp/` a
 * location in the servlet context, and neither is a path in the repository. What
 * both DO say is how the directory ends, and that is enough to pick it out of
 * the directories this walk found: `src/main/resources/templates` ends with
 * `templates`, `src/main/webapp/WEB-INF/jsp` with `WEB-INF/jsp`.
 *
 * @param {string|null} prefix  as the configuration wrote it
 * @returns {string|null} a path suffix with no leading or trailing slash
 */
export function templatePrefixPath(prefix) {
  let s = String(prefix ?? '').trim();
  if (s === '') return null;
  s = s.replace(/^(?:classpath\*?|file|servletContext):/i, '');
  s = s.replace(/^\/+/, '').replace(/\/+$/, '');
  if (s === '' || s.includes('$')) return null;
  return s;
}

/** The longest directory every one of these paths starts with. */
function commonDirectory(dirs) {
  const lists = dirs.map((d) => d.split('/').filter((x) => x !== ''));
  if (lists.length === 0) return null;
  const out = [];
  for (let i = 0; i < lists[0].length; i += 1) {
    const seg = lists[0][i];
    if (!lists.every((l) => l[i] === seg)) break;
    out.push(seg);
  }
  return out.join('/');
}

/**
 * The RESOURCE ROOT a template directory belongs to: the ancestor path up to and
 * including the last `resources` or `webapp` segment.
 *
 * It is what keeps a multi-module repository's modules apart. Two modules that
 * each keep templates have two template roots, and a common ancestor taken
 * across both would be the repository itself.
 *
 * @param {string} relDir
 * @returns {string} the group key, or the directory itself when it has neither
 */
function resourceRootOf(relDir) {
  const segments = String(relDir ?? '').split('/').filter((x) => x !== '' && x !== '.');
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    if (segments[i] === 'resources' || segments[i] === 'webapp') return segments.slice(0, i + 1).join('/');
  }
  return segments.join('/');
}

/**
 * THE TEMPLATE ROOTS of a tree: where a view name is resolved, by which engine,
 * with which suffix. Pure — the caller does the walking and the reading.
 *
 * Two ways a root is found, and the run says which:
 *   config   the view resolver names a prefix, and a directory holding template
 *            files ends the way that prefix does
 *   default  nothing names one, so the root is the directory every template file
 *            of that engine sits under, inside one resource root
 *
 * @param {{dirs:Map<string, Map<string, number>>, resolvers:Object[],
 *          engineMarkers?:Map<string, Set<string>>}} input
 *        `dirs` maps a root-relative directory to a map of extension -> count
 * @returns {{root:string, engine:string, suffix:string, from:string, files:number}[]}
 */
export function templateRootsOf(input) {
  const dirs = input.dirs instanceof Map ? input.dirs : new Map();
  const resolvers = Array.isArray(input.resolvers) ? input.resolvers : [];
  const markers = input.engineMarkers instanceof Map ? input.engineMarkers : new Map();
  const out = [];
  for (const spec of TEMPLATE_ENGINES) {
    const declared = resolvers.find((r) => r && r.engine === spec.engine) ?? null;
    const holds = [];
    for (const [dir, byExt] of dirs) {
      let n = 0;
      for (const ext of spec.extensions) n += byExt.get(ext) ?? 0;
      if (n === 0) continue;
      if (spec.underTemplateDirOnly && declared === null) {
        const segments = dir.split('/');
        if (!segments.some((sg) => TEMPLATE_DIR_SEGMENTS.includes(sg))) continue;
      }
      holds.push({ dir, files: n });
    }
    if (holds.length === 0) continue;
    const suffix = (declared && typeof declared.suffix === 'string' && declared.suffix !== '')
      ? declared.suffix : spec.defaultSuffix;
    const configured = templatePrefixPath(declared ? declared.prefix : null);
    // THE ENGINE'S OWN DOCUMENTED DEFAULT, when the project configured nothing.
    // Thymeleaf, FreeMarker and Velocity all resolve against
    // `classpath:/templates/` out of the box, so a directory ending that way IS
    // the root even in a module holding one page: taking the directory the files
    // happen to share would make `templates/channelUser/x.ftl` a root of its own
    // and `channelUser/x` would then resolve to nothing.
    const prefixPath = configured ?? (spec.defaultPrefix ?? null);
    const roots = new Map();
    if (prefixPath !== null) {
      for (const h of holds) {
        const hit = ancestorEndingWith(h.dir, prefixPath);
        if (hit === null) continue;
        roots.set(hit, (roots.get(hit) ?? 0) + h.files);
      }
    }
    const from = roots.size === 0 ? 'default' : configured !== null ? 'config' : 'default';
    if (roots.size === 0) {
      const byResource = new Map();
      for (const h of holds) {
        const key = resourceRootOf(h.dir);
        if (!byResource.has(key)) byResource.set(key, []);
        byResource.get(key).push(h);
      }
      for (const group of byResource.values()) {
        const root = commonDirectory(group.map((h) => h.dir));
        if (root === null || root === '') continue;
        roots.set(root, group.reduce((n, h) => n + h.files, 0));
      }
    }
    for (const [root, files] of [...roots.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      // A `.html` root is Thymeleaf when something says so, and PLAIN HTML when
      // nothing does. Saying "thymeleaf" over a directory of ordinary pages
      // would be naming a technology this run did not see.
      let engine = spec.engine;
      if (spec.engine === 'thymeleaf' && declared === null && !(markers.get(root) ?? new Set()).has('thymeleaf')) {
        engine = 'plain-html';
      }
      out.push({ root, engine, suffix, from, files });
    }
  }
  out.sort((a, b) => (a.root < b.root ? -1 : a.root > b.root ? 1 : a.engine < b.engine ? -1 : 1));
  return out;
}

/** The longest ancestor of `dir` (itself included) whose path ends with `tail`. */
function ancestorEndingWith(dir, tail) {
  const want = `/${tail}`;
  let cur = String(dir ?? '');
  for (let i = 0; i < 64 && cur !== ''; i += 1) {
    if (cur === tail || cur.endsWith(want)) return cur;
    const cut = cur.lastIndexOf('/');
    if (cut < 0) break;
    cur = cur.slice(0, cut);
  }
  return null;
}

/** Every `<script src="...">` an HTML page loads, in source order. */
export function scriptSourcesOf(html) {
  const out = [];
  const re = /<script\b[^>]*\bsrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let m;
  while ((m = re.exec(String(html ?? ''))) !== null) {
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    if (value !== '') out.push(value);
  }
  return out;
}

/**
 * One `<script src>` read as a path under the page's own directory.
 *
 * A page served from `static/` writes `/scripts/app.js` for the file that sits
 * at `static/scripts/app.js`: the leading slash is the SERVER's root, which is
 * the directory holding the page. A relative `scripts/app.js` names the same
 * file. An address with a host is somebody else's file and is not one of ours.
 *
 * @param {string} dir  the page's directory, root-relative
 * @param {string} src  the src attribute as written
 * @returns {string|null} a root-relative path, or null when the src is not local
 */
export function scriptTargetOf(dir, src) {
  let s = String(src ?? '').trim();
  if (s === '' || /^[a-z][a-z0-9+.-]*:/i.test(s) || s.startsWith('//')) return null;
  s = s.split('#')[0].split('?')[0];
  if (s === '') return null;
  s = s.replace(/^\/+/, '').replace(/^\.\//, '');
  const base = dir === '.' || dir === '' ? '' : `${dir}/`;
  const out = [];
  for (const seg of `${base}${s}`.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (out.length > 0) out.pop(); continue; }
    out.push(seg);
  }
  return out.length > 0 ? out.join('/') : null;
}

const MYSQL_DDL_RE = /`|ENGINE\s*=/;

/**
 * WHICH DIALECT A .sql FILE IS WRITTEN IN, from spellings only that dialect has.
 *
 * A repository that ships its schema three times — MySQL, PostgreSQL, H2 — has
 * three files that describe the SAME tables, and applying all three would
 * declare every table two or three times over. The file has to say which one it
 * is, and it does: the syntax is not portable.
 *
 * Order matters: the more distinctive spellings are tested first, because a
 * PostgreSQL dump can contain `ENGINE` inside a comment and an Oracle one can
 * contain a backtick in a string. Each entry is (dialect, pattern).
 */
const DDL_DIALECT_MARKERS = Object.freeze([
  // A backtick-quoted identifier is MySQL's alone, and a MySQL dump is full of
  // them — tested first so a stray `NUMBER(` in a comment cannot call it Oracle.
  ['mysql', /`/],
  ['oracle', /\bVARCHAR2\s*\(|\bNUMBER\s*\(/i],
  ['postgres', /\b(?:BIG)?SERIAL\b|::\s*[A-Za-z]|\bOWNER\s+TO\b/i],
  ['h2', /\bCACHED\s+TABLE\b|\bGENERATED\s+BY\s+DEFAULT\s+AS\s+IDENTITY\b|\bIDENTITY\b/i],
  // `engine=InnoDB` is written in every case there is; the hint regex above is
  // deliberately left alone, because other things read it.
  ['mysql', /\bENGINE\s*=/i],
]);

/**
 * DIALECT NAMES AS THEY APPEAR IN PATHS. A repository that ships its schema for
 * several databases says so where it is easiest to read: `dolphinscheduler_h2.sql`
 * next to `dolphinscheduler_mysql.sql`, or `db/mysql/schema.sql` next to
 * `db/hsqldb/schema.sql`.
 *
 * The PATH WINS over the content markers, and it has to: an H2 file written in
 * H2's MySQL compatibility mode is full of backticks, so its text says `mysql`
 * while its name says `h2` — and applying both would declare every table twice.
 * A name is the project stating which database a file is for; a marker is this
 * engine inferring it.
 *
 * Each entry is (canonical dialect, the spellings that name it in a path).
 */
const DDL_DIALECT_PATH_NAMES = Object.freeze([
  // MariaDB AHEAD OF MySQL, and a canonical name of its own (RM55). The two
  // parse alike, so the engine reads a MariaDB file with the MySQL grammar —
  // but a repository that ships BOTH ships the same tables twice, and folding
  // the name into `mysql` would apply both copies and declare every table
  // twice. eGovFrame's common components do exactly that.
  ['mariadb', ['mariadb', 'maria']],
  ['mysql', ['mysql']],
  ['postgres', ['postgres', 'postgresql', 'pgsql', 'pg']],
  ['oracle', ['oracle']],
  ['hsqldb', ['hsqldb', 'hsql']],
  ['h2', ['h2']],
  ['sqlserver', ['sqlserver', 'mssql']],
  ['db2', ['db2']],
  ['sqlite', ['sqlite']],
  // THE FOUR THE KOREAN MARKET SHIPS AND NOBODY ELSE DOES (RM55). Without them
  // `script/ddl/tibero/com_DDL_tibero.sql` reads as "portable" — no name, no
  // marker — and a portable file is kept whichever vendor wins, so
  // egovframe-common-components applied all eight vendors' DDL at once and
  // declared 182 tables eight times over (13,505 duplicate-declaration
  // warnings, measured). A vendor directory is the project saying which
  // database a file is for, and that is all these names read.
  ['tibero', ['tibero']],
  ['cubrid', ['cubrid']],
  ['altibase', ['altibase']],
  ['goldilocks', ['goldilocks']],
]);

/**
 * The dialect a path NAMES, or null. Matched on whole tokens only, so `pg` in
 * `pgadmin-notes.sql` is not a match and `dm` never is (too short to be a token
 * anyone means).
 * @param {string} relPath
 * @returns {string|null}
 */
export function ddlDialectFromPath(relPath) {
  const lower = String(relPath ?? '').toLowerCase();
  for (const [canonical, spellings] of DDL_DIALECT_PATH_NAMES) {
    for (const name of spellings) {
      if (new RegExp(`(^|[^a-z0-9])${name}([^a-z0-9]|$)`).test(lower)) return canonical;
    }
  }
  return null;
}

/**
 * A path segment that says, on its own, that a file is a MIGRATION rather than
 * a schema — the four tool conventions plus the two words projects use when
 * they roll their own.
 */
const MIGRATION_PATH_RE = /(^|\/)(?:flyway|liquibase|migration|migrations|upgrade|upgrades|patch|patches)(\/|$)/i;

const CREATE_TABLE_G = /\bcreate\s+table\b/gi;
const ALTER_TABLE_G = /\balter\s+table\b/gi;
const DML_G = /\b(?:insert\s+into|update\s+[`"\w]|delete\s+from)\b/gi;

/**
 * WHAT A .sql FILE IS, from its text and its path. Pure.
 *
 * Two questions, answered separately because they fail separately:
 *
 *   `dialect`  which database's syntax it is written in — null when nothing in
 *              the file is distinctive enough to say (a portable dump).
 *   `role`     'schema' when the file mostly DECLARES tables; 'migration' when
 *              it mostly CHANGES them, or when it sits under a path segment that
 *              names a migration tool. A migration is not applied by default:
 *              it means nothing without the schema it amends and without its
 *              siblings in the right order.
 *
 * The counts ride along so the classification can be PRINTED rather than
 * asserted — a reader who disagrees can see what it counted.
 *
 * @param {string} relPath  root-relative POSIX path
 * @param {string} text     the file's text
 * @returns {{path:string, dialect:(string|null), dialectFrom:('path'|'content'|null),
 *            role:('schema'|'migration'), createTables:number, alters:number,
 *            dml:number, byPath:boolean, testPath:boolean}}
 */
export function classifyDdlFile(relPath, text) {
  const body = String(text ?? '');
  const createTables = (body.match(CREATE_TABLE_G) ?? []).length;
  const alters = (body.match(ALTER_TABLE_G) ?? []).length;
  const dml = (body.match(DML_G) ?? []).length;
  // The path first: a name is a statement, a marker is an inference.
  let dialect = ddlDialectFromPath(relPath);
  let dialectFrom = dialect ? 'path' : null;
  if (!dialect) {
    for (const [name, re] of DDL_DIALECT_MARKERS) {
      if (re.test(body)) { dialect = name; dialectFrom = 'content'; break; }
    }
  }
  const byPath = MIGRATION_PATH_RE.test(String(relPath ?? ''));
  // WHAT MAKES A FILE A MIGRATION is that it CHANGES tables somebody else
  // declared — not that it is long, and not that it seeds rows. A schema dump
  // that ends with 250 INSERTs is still the schema: `catalog_ddl.py` reads no
  // INSERT at all, so the seed data is invisible to the catalog either way, and
  // counting it would misfile the main DDL of most projects that ship one.
  //
  //   nothing declared at all  -> it can only be amending something
  //   more ALTER than CREATE   -> it is amending more than it declares
  //   a migration-tool path    -> the tool owns the order, and it is not ours
  const testPath = isTestPath(String(relPath ?? ''));
  const role = (byPath || createTables === 0 || alters > createTables) ? 'migration' : 'schema';
  return { path: relPath, dialect, dialectFrom, role, createTables, alters, dml, byPath, testPath };
}

/**
 * Walk `root` and describe what is there. Pure — all I/O is injected.
 *
 * @param {string} root  absolute path of the tree to scan
 * @param {{
 *   readDir: (absDir:string) => {name:string, isDir:boolean, isFile:boolean}[],
 *   readFile: (absFile:string) => string,
 *   gitHead: (absDir:string) => (string|null),
 *   maxFiles?: number
 * }} io
 * @returns {{
 *   root:string,
 *   repos:{path:string, commit:string, javaFiles:number, frontendPackageJson:number}[],
 *   counts:{javaFiles:number, javaTestFiles:number, springHandlerFiles:number, mybatisMapperXml:number, ddlFiles:number, jpaEntityFiles:number, mybatisPlusFiles:number, kotlinFiles:number, frontendPackageJson:number, webFiles:number, vueFiles:number},
 *   buildTool:('maven'|'gradle'|null),
 *   packagePrefixes:string[],
 *   mapperDirs:string[],
 *   webSourceRoots:string[],
 *   webPackages:{path:string, root:string, framework:string, router:(string|null), http:string[]}[],
 *   webVendoredRoots:{root:string, files:number, routerPacks:string[]}[],
 *   openapiDocuments:{path:string, version:('3'|'2'|'unknown')}[],
 *   javaSourceRoots:string[],
 *   javaTestRoots:string[],
 *   ddlPaths:string[],
 *   ddlCandidates:{path:string, dialect:(string|null), dialectFrom:(string|null), role:string, createTables:number, alters:number, dml:number, byPath:boolean, testPath:boolean}[],
 *   ddlDialectHint:('mysql'|null),
 *   connectionCandidates:Object[],
 *   serviceNames:{name:string, file:string}[],
 *   gatewayRoutes:{front:string, to:string, service:(string|null), file:string, id:(string|null)}[],
 *   externalConfigImports:{file:string, value:string}[],
 *   filesScanned:number,
 *   capped:boolean,
 *   diagnostics:{kind:string, severity:string, path:string, reason:string}[]
 * }}
 */
/**
 * An `index.html` beside loose scripts: the one file that can say which
 * directory the server treats as the root of a frontend with no manifest.
 * Noted, not read — only the directories that turn out to hold frontend
 * sources are opened, after the walk.
 * @returns {boolean} true when this file's classification is FINISHED here
 */
function classifyIndexPage(d, f) {
  const { absFile, lower, inPackage, rel } = f;
  const { looseIndexPages } = d;
  // An `index.html` beside loose scripts is the one file that can say which
  // directory the server treats as its root. Noted, not read: only the
  // directories that turn out to hold frontend sources are opened, after the
  // walk.
  if (lower === 'index.html' && inPackage !== true) {
    const dir = rel(path.dirname(absFile));
    if (outsideVendorDirs(dir)) looseIndexPages.set(dir, absFile);
  }

  return false;
}

/**
 * A TEMPLATE FILE (RM48), noted by directory and extension and never read
 * here: WHICH of these directories is a template root depends on the view
 * resolver settings, which are read from the configuration files below.
 * @returns {boolean} true when this file's classification is FINISHED here
 */
function classifyTemplateFile(d, f) {
  const { absFile, lower, rel } = f;
  const { templateDirs, templateSample } = d;
  // A TEMPLATE FILE (RM48). Noted by directory and extension, never read here:
  // which of these directories is a template ROOT depends on the view resolver
  // settings, and those are read from the configuration files further down.
  const templateExt = TEMPLATE_ENGINES
    .flatMap((e) => e.extensions)
    .find((e) => lower.endsWith(e)) ?? null;
  if (templateExt !== null) {
    const dir = rel(path.dirname(absFile));
    if (outsideVendorDirs(dir)) {
      if (!templateDirs.has(dir)) templateDirs.set(dir, new Map());
      const byExt = templateDirs.get(dir);
      byExt.set(templateExt, (byExt.get(templateExt) ?? 0) + 1);
      if (!templateSample.has(dir)) templateSample.set(dir, []);
      const sample = templateSample.get(dir);
      if (sample.length < 3) sample.push(absFile);
    }
  }

  return false;
}

/**
 * A frontend source file. Counted BEFORE the java/xml/sql branches so a `.vue`
 * or a `.ts` never falls through to "a technology this engine has no lane for".
 * @returns {boolean} true when this file's classification is FINISHED here
 */
function classifyWebSource(d, f) {
  const { absFile, name, lower, dirEntries, inPackage, rel } = f;
  const { counts, looseWebFiles, looseWebPaths } = d;
  // Counted BEFORE the java/xml/sql branches so a `.vue` or `.ts` never falls
  // through to nothing. The web lane reads these files (RM26), so they are an
  // input, not an uncovered technology.
  if (isWebSourceFile(name)) {
    counts.webFiles += 1;
    if (lower.endsWith('.vue')) counts.vueFiles += 1;
    // A SOURCE MAP BESIDE IT MEANS A BUILD WROTE IT. `app.cebd468e.js` is not
    // spelled `.min.js` and is a webpack chunk all the same; nobody writes a
    // `.js.map` by hand, so the pair is the one generic thing that says
    // "generated". A directory of those is output, not a frontend somebody
    // keeps here, and reading it would put a bundle's insides in the graph.
    const generated = (dirEntries ?? []).some((e) => e.isFile && e.name === `${name}.map`);
    if (inPackage !== true && !generated) {
      const dir = rel(path.dirname(absFile));
      if (outsideVendorDirs(dir)) {
        looseWebFiles.set(dir, (looseWebFiles.get(dir) ?? 0) + 1);
        looseWebPaths.add(rel(absFile));
      }
    }
    return true;
  }

  return false;
}

/**
 * A Java source: the package it declares, the source root that package implies,
 * and what its annotations say this project uses.
 * @returns {boolean} true when this file's classification is FINISHED here
 */
function classifyJavaFile(d, f) {
  const { absFile, lower, stats, rel } = f;
  const { addRoot, counts, packageCounts, read, root } = d;
  if (lower.endsWith('.java')) {
    counts.javaFiles += 1;
    if (isTestPath(rel(absFile))) counts.javaTestFiles += 1;
    if (stats) stats.javaFiles += 1;
    const text = read(absFile);
    if (text === null) return;
    const pkg = PACKAGE_DECL_RE.exec(text);
    const dir = path.dirname(absFile);
    if (pkg) {
      d.javaWithPackage += 1;
      const declared = pkg[1].replace(/[ \t]/g, '');
      const prefix = prefixOf(declared);
      packageCounts.set(prefix, (packageCounts.get(prefix) ?? 0) + 1);
      addRoot(rel(sourceRootOf(dir, declared, root)));
    } else {
      // No package declaration: the file's own directory IS the source root.
      addRoot(rel(dir));
    }
    if (SPRING_HANDLER_RE.test(text)) counts.springHandlerFiles += 1;
    // A JPA entity is a LANE as of M10, not an uncovered technology: the count
    // is what makes `cascade init` declare the `jpa` framework pack.
    if (JPA_ENTITY_RE.test(text)) counts.jpaEntityFiles += 1;
    // Same rule, same reason: the count is what makes `cascade init` declare
    // the `mybatis-plus` framework pack.
    if (MYBATIS_PLUS_RE.test(text)) counts.mybatisPlusFiles += 1;
    return true;
  }

  return false;
}

/**
 * A Kotlin source. A `build.gradle.kts` is configuration, not a source, so only
 * `.kt` counts here.
 * @returns {boolean} true when this file's classification is FINISHED here
 */
function classifyKotlinFile(d, f) {
  const { absFile, lower, rel } = f;
  const { counts, diagnostics } = d;
  // Kotlin build scripts (build.gradle.kts) are configuration, not sources;
  // only `.kt` counts as a Kotlin source here.
  if (lower.endsWith('.kt')) {
    counts.kotlinFiles += 1;
    diagnostics.push({
      kind: 'UNSUPPORTED_TECHNOLOGY', severity: 'info', path: rel(absFile),
      reason: 'Kotlin source: the engine ships no Kotlin lane, so this file contributes nothing to the graph',
    });
    return true;
  }

  return false;
}

/**
 * An XML file: a MyBatis mapper, or an XML this engine has no question about.
 * @returns {boolean} true when this file's classification is FINISHED here
 */
function classifyXmlFile(d, f) {
  const { absFile, lower, rel } = f;
  const { counts, mapperDirs, read, xmlViewResolvers } = d;
  if (lower.endsWith('.xml')) {
    const text = read(absFile);
    if (text === null) return;
    if (MYBATIS_MAPPER_RE.test(text)) {
      counts.mybatisMapperXml += 1;
      mapperDirs.add(rel(path.dirname(absFile)));
      return true;
    }
    // A SPRING MVC PROJECT WRITES ITS VIEW RESOLVER AS A BEAN (RM55). The same
    // setting a Boot project puts in `application.yml`, in the spelling every
    // pre-Boot Spring MVC application uses — which is what eGovFrame is. Read
    // by its ROOT ELEMENT and not by its file name: `dispatcher-servlet.xml`,
    // `egov-com-servlet.xml` and `spring-mvc.xml` are the same document, and a
    // list of names is a rule that would stop at the next project's spelling.
    const relFile = rel(absFile);
    if (!isTestPath(relFile) && looksLikeSpringBeansXml(text)) {
      xmlViewResolvers.push(...findXmlViewResolvers([{ path: relFile, text }]));
    }
    return true;
  }

  return false;
}

/**
 * An OpenAPI / Swagger document — an EVIDENCE LAYER, not a technology with no
 * lane. TESTED BEFORE THE CONNECTION-FILE RULE, and it has to be: that rule
 * claims every `.yml` in the tree, and no file is both a contract and a
 * datasource configuration.
 * @returns {boolean} true when this file's classification is FINISHED here
 */
function classifyOpenApiDocument(d, f) {
  const { absFile, name, lower, rel } = f;
  const { diagnostics, openapiDocuments, read } = d;
  // An OpenAPI / Swagger document is an EVIDENCE LAYER, not a technology this
  // engine has no lane for: it declares routes, and RM29's bridge reads them.
  //
  // TESTED BEFORE THE CONNECTION-FILE RULE, and it has to be: that rule claims
  // every `.yml`/`.yaml` in the tree, so a document tested after it would never
  // be seen. A file whose head says `openapi:` is a contract, not a datasource
  // configuration, and no file is both.
  if (name !== 'package.json' && OPENAPI_EXTENSIONS.some((e) => lower.endsWith(e))) {
    const text = read(absFile);
    if (text !== null) {
      const head = text.slice(0, OPENAPI_HEAD_BYTES);
      const version = openApiVersionOf(head);
      if (version !== null && (version !== 'unknown' || OPENAPI_PATHS_KEY.test(head))) {
        if (text.length > OPENAPI_MAX_BYTES) {
          diagnostics.push({
            kind: 'UNREADABLE_FILE', severity: 'warn', path: rel(absFile),
            reason: `this OpenAPI document is ${Math.round(text.length / 1024)} KB, over the ${OPENAPI_MAX_BYTES / 1024 / 1024} MB this engine reads. Its routes are not in the pack; point --openapi at a smaller document if one is published`,
          });
        } else {
          openapiDocuments.push({ path: rel(absFile), version });
        }
        return true;
      }
    }
  }

  return false;
}

/**
 * A Spring configuration or a connection file. ONE READ, TWO QUESTIONS: where
 * is the database, and who is this service and where does it forward a
 * request? Reading the file twice would be the same bytes and a second chance
 * for the two answers to disagree about which file they came from.
 * @returns {boolean} true when this file's classification is FINISHED here
 */
function classifySpringConfig(d, f) {
  const { absFile, rel } = f;
  const {
    connectionCandidates, dbTypeDeclarations, diagnostics, externalConfigImports,
    gatewayRoutes, read, serviceNames, viewResolvers,
  } = d;
  // The RELATIVE PATH, not the bare name: a `.properties` under `static/` or
  // `locale*/` is a presentation resource, and reading it produced diagnostics
  // about files that were never connection candidates (see dbconfig.mjs).
  //
  // ONE READ, TWO QUESTIONS. A Spring `application.yml` answers "where is the
  // database?" (dbconfig.mjs) and "who is this service, and where does it
  // forward a request?" (springconfig.mjs, RM46). Reading the file twice would
  // be the same bytes and a second chance for the two answers to disagree
  // about which file they came from.
  const relFile = rel(absFile);
  const springConfig = looksLikeSpringConfigFile(relFile) && !isTestPath(relFile);
  if (springConfig || looksLikeConnectionFile(relFile)) {
    const text = read(absFile);
    if (text === null) return;
    const one = [{ path: relFile, text }];
    if (springConfig) {
      serviceNames.push(...findServiceNames(one, diagnostics));
      gatewayRoutes.push(...findGatewayRoutes(one, diagnostics));
      externalConfigImports.push(...findExternalConfigImports(one));
      viewResolvers.push(...findViewResolvers(one, diagnostics));
    }
    if (looksLikeConnectionFile(relFile)) {
      connectionCandidates.push(...findConnectionCandidates(one, diagnostics));
      // …and the THIRD question of the same read (RM55): does this file say
      // outright which database vendor the project runs on? A repository that
      // ships its schema seven times over answers it here and nowhere else.
      if (!isTestPath(relFile)) {
        dbTypeDeclarations.push(...findDbTypeDeclarations(one, (v) => Object.hasOwn(SQL_DIALECT_ALIASES, v)));
      }
    }
    return true;
  }

  return false;
}

/**
 * A `.sql` file: does it declare a table, amend one, or neither?
 * @returns {boolean} true when this file's classification is FINISHED here
 */
function classifySqlFile(d, f) {
  const { absFile, lower, rel } = f;
  const { counts, ddlCandidates, ddlPaths, read } = d;
  if (lower.endsWith('.sql')) {
    const text = read(absFile);
    if (text === null) return;
    if (CREATE_TABLE_RE.test(text)) {
      counts.ddlFiles += 1;
      ddlPaths.push(rel(absFile));
      if (d.ddlDialectHint === null && MYSQL_DDL_RE.test(text)) d.ddlDialectHint = 'mysql';
    }
    // EVERY candidate, classified — including the ones that only ALTER, which
    // `ddlPaths` (CREATE TABLE only) never listed. Without them the run cannot
    // say how many migration files it left out, and a silent omission is the
    // one thing a catalog decision must not be.
    if (CREATE_TABLE_RE.test(text) || ALTER_TABLE_RE.test(text)) {
      ddlCandidates.push(classifyDdlFile(rel(absFile), text));
    }
    return true;
  }

  return false;
}

/**
 * A `package.json`, and what its dependencies declare about the frontend it
 * describes.
 * @returns {boolean} true when this file's classification is FINISHED here
 */
function classifyPackageManifest(d, f) {
  const { absFile, name, dirEntries, stats, rel } = f;
  const { counts, diagnostics, read, webPackages } = d;
  if (name === 'package.json') {
    const text = read(absFile);
    if (text === null) return;
    let pkg;
    try {
      pkg = JSON.parse(text);
    } catch (e) {
      diagnostics.push({
        kind: 'UNREADABLE_FILE', severity: 'warn', path: rel(absFile),
        reason: `package.json is not valid JSON: ${e.message}`,
      });
      return true;
    }
    const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
    if (FRONTEND_DEPS.some((dep) => Object.prototype.hasOwnProperty.call(deps, dep))) {
      counts.frontendPackageJson += 1;
      if (stats) stats.frontendPackageJson += 1;
      // NO `UNSUPPORTED_TECHNOLOGY` here any more: as of RM26 there IS a web
      // lane, and it reads this package. What it does not yet do is attach a
      // frontend call to an endpoint, and that is stated on the `web` axis
      // (src/core/lanes.mjs) rather than as a discovery diagnostic.
      //
      // Angular and Svelte get no diagnostic either: their HTTP calls carry
      // URL literals like anyone else's, so the lane reads them too. What the
      // record says is which framework the package DECLARED, and nothing more.
      const dir = path.dirname(absFile);
      const framework = FRAMEWORK_DEPS.find(([, names]) =>
        names.some((n) => Object.prototype.hasOwnProperty.call(deps, n)));
      const router = routerDependencyOf(deps);
      const http = [];
      if (Object.prototype.hasOwnProperty.call(deps, 'axios')) http.push('axios');
      if (http.length === 0) http.push('fetch-only');
      // `<dir>/src` when the package keeps its sources there, which is the
      // near-universal layout; otherwise the package directory itself, so a
      // flat package is still read rather than skipped.
      const hasSrc = (dirEntries ?? []).some((e) => e.isDir && e.name === 'src');
      webPackages.push({
        path: rel(absFile),
        root: rel(hasSrc ? path.join(dir, 'src') : dir),
        framework: framework ? framework[0] : 'unknown',
        router,
        http,
      });
    }
  }
  return false;
}

/**
 * ONE FILE, ONE ANSWER. The classifiers run in this order and the first that
 * says it is finished ends the question — which is the rule the old chain of
 * `if … return;` branches spelled out by falling through. The first two never
 * finish anything: an `index.html` and a template file are NOTED, and the file
 * is then still whatever else it is.
 */
function classifyFile(d, f) {
  if (classifyIndexPage(d, f)) return;
  if (classifyTemplateFile(d, f)) return;
  if (classifyWebSource(d, f)) return;
  if (classifyJavaFile(d, f)) return;
  if (classifyKotlinFile(d, f)) return;
  if (classifyXmlFile(d, f)) return;
  if (classifyOpenApiDocument(d, f)) return;
  if (classifySpringConfig(d, f)) return;
  if (classifySqlFile(d, f)) return;
  if (classifyPackageManifest(d, f)) return;
}

/**
 * THE WALK, and the four things only the walk can answer: how many files it
 * scanned, whether it hit its cap, and whether the tree carries a Maven or a
 * Gradle build. Every file it reaches is handed to `classify`, which decides
 * what that file IS; nothing here reads a file for its content.
 *
 * @param {{readDir:Function, readFile:Function, gitHead:Function}} io
 * @param {object} w   the walk's own counters, written in place
 * @param {object} ctx everything the walk needs from the caller
 * @returns {{walk:Function, addRoot:Function, read:Function}}
 */
function makeWalker(io, w, ctx) {
  const { readDir, readFile, gitHead } = io;
  const {
    classify, diagnostics, javaRoots, javaTestRoots, maxFiles, rel, repoStats,
  } = ctx;
const repoOf = (stack) => (stack.length ? stack[stack.length - 1] : null);

const noteRepo = (absDir) => {
  const key = rel(absDir);
  const commit = gitHead(absDir);
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit)) {
    diagnostics.push({
      kind: 'REPOSITORY_WITHOUT_HEAD',
      severity: 'warn',
      path: key,
      reason: 'git repository has no resolvable HEAD commit (empty repository?); excluded from the manifest, which pins every repo to a full commit',
    });
    return null;
  }
  if (!repoStats.has(key)) {
    repoStats.set(key, { path: key, commit, javaFiles: 0, frontendPackageJson: 0 });
  }
  return key;
};

const walk = (absDir, repoStack, isRepoRoot, underPackage = false) => {
  if (w.capped) return;
  let entries;
  try {
    entries = readDir(absDir);
  } catch (e) {
    diagnostics.push({
      kind: 'UNREADABLE_DIRECTORY', severity: 'warn', path: rel(absDir),
      reason: `cannot list directory: ${e.message}`,
    });
    return;
  }
  entries = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  // A directory holding `.git` (a dir, or a file for linked worktrees) is a
  // repository — the root included (§5, nested repos are listed separately).
  const hasGit = entries.some((e) => e.name === '.git');
  let stack = repoStack;
  if (hasGit) {
    const key = noteRepo(absDir);
    if (key !== null) stack = [...repoStack, key];
  }

  // "No package.json in any ancestor INSIDE THE REPOSITORY": a nested checkout
  // starts the question again, because a manifest in the outer tree says
  // nothing about the inner one.
  const inPackage = (hasGit ? false : underPackage)
    || entries.some((e) => e.isFile && e.name === 'package.json');

  if (isRepoRoot || hasGit) {
    if (entries.some((e) => e.isFile && e.name === 'pom.xml')) w.sawPom = true;
    if (entries.some((e) => e.isFile && (e.name === 'build.gradle' || e.name === 'build.gradle.kts'))) w.sawGradle = true;
  }

  for (const entry of entries) {
    if (w.capped) return;
    if (entry.isDir) {
      if (SKIP_DIRS.includes(entry.name)) continue;
      walk(path.join(absDir, entry.name), stack, false, inPackage);
      continue;
    }
    if (!entry.isFile) continue; // symlinks and specials: not walked, not counted
    w.filesScanned += 1;
    if (w.filesScanned > maxFiles) {
      w.capped = true;
      diagnostics.push({
        kind: 'FILE_CAP_REACHED', severity: 'warn', path: rel(absDir),
        reason: `walk stopped after ${maxFiles} files; the discovery below describes only the part of the tree that was scanned`,
      });
      return;
    }
    classify(path.join(absDir, entry.name), entry.name, repoOf(stack), entries, inPackage);
  }
};

// A root under the standard Maven/Gradle test layout goes on the TEST list,
// not the main one. It is reported either way — never dropped (§7.3).
const addRoot = (relRoot) => {
  (isTestPath(relRoot) ? javaTestRoots : javaRoots).add(relRoot);
};

const read = (absFile) => {
  try {
    return readFile(absFile);
  } catch (e) {
    diagnostics.push({
      kind: 'UNREADABLE_FILE', severity: 'warn', path: rel(absFile),
      reason: `cannot read file: ${e.message}`,
    });
    return null;
  }
};

  return { walk, addRoot, read };
}


/**
 * A FRONTEND WITH NO PACKAGE MANIFEST (RM47). Every directory that holds
 * frontend sources with no `package.json` above it is a candidate root; the
 * `index.html` beside it, where there is one, says which of them the server
 * really serves, and its `<script src>` list is the evidence.
 *
 * It runs AFTER the walk because the rule needs the whole file list.
 *
 * @returns {object[]} one entry per root, in the shape a web package has
 */
function looseWebRoots(d) {
  const { counts, looseIndexPages, looseWebFiles, looseWebPaths, read, root } = d;
// ---- a frontend with no package manifest (RM47) --------------------------
//
// Everything above answers "which frontend PACKAGE is here?". A gateway that
// ships AngularJS as `<script>` tags has none, and refusing to read it left
// the whole screen side of that project invisible. So a directory of frontend
// sources with no manifest above it is a web root when the tree SAYS it is
// served: it sits under a `static`/`public`/`webapp`/`www` directory (or
// under `resources/templates`), or an `index.html` beside it loads one of its
// files by `<script src>`. Nothing else is enough — a build helper next to a
// pom is not a frontend, and neither is a directory of loose scripts nobody
// serves.
const servedDirs = [];
for (const dir of [...looseWebFiles.keys()].sort()) {
  if (underWebRootDir(dir)) { servedDirs.push(dir); continue; }
  const page = looseIndexPages.get(dir);
  if (page === undefined) continue;
  const html = read(page);
  if (html === null) continue;
  const loadsOwnFile = scriptSourcesOf(html)
    .map((src) => scriptTargetOf(dir, src))
    .some((target) => target !== null && looseWebPaths.has(target));
  if (loadsOwnFile) servedDirs.push(dir);
}
const webVendoredRoots = minimalRoots(servedDirs).map((vendorRoot) => {
  const under = (p) => p === vendorRoot || p.startsWith(`${vendorRoot}/`);
  let files = 0;
  for (const [dir, n] of looseWebFiles) if (under(dir)) files += n;
  // WHICH ROUTER THIS IS, from the source alone. No dependency list names the
  // framework here, so the registrar the code writes is the only thing that
  // can, and a bounded read of the root's own files is what says it.
  const scanned = [...looseWebPaths].filter(under).sort().slice(0, ROUTER_SCAN_FILES);
  const named = new Set();
  for (const relPath of scanned) {
    const text = read(path.resolve(root, relPath));
    if (text === null) continue;
    const head = text.slice(0, ROUTER_SCAN_BYTES);
    for (const [pack, markers] of ROUTER_SOURCE_MARKERS) {
      if (markers.some((m) => head.includes(m))) named.add(pack);
    }
  }
  return { root: vendorRoot, files, routerPacks: [...named].sort() };
});
counts.webVendoredFiles = webVendoredRoots.reduce((n, r) => n + r.files, 0);

  return webVendoredRoots;
}

/**
 * THE TEMPLATE ROOTS (RM48). Which of the directories holding template files is
 * a ROOT depends on the view resolver settings and on what the markup itself
 * says: two engines share the `.html` extension, and only the root's own files
 * can tell them apart.
 *
 * @returns {object[]} the roots, each with the engine it was read as
 */
function templateRootsFrom(d) {
  const { counts, diagnostics, externalConfigImports, read, templateDirs, templateSample } = d;
// THE RESOLVERS, IN THE ORDER THE RULE READS THEM. A project's own Spring
// configuration first, then the bean XMLs, each in its declared `order` — which
// is the order the container itself tries them in, so the first one that names
// a prefix is the first one that would resolve a view.
const viewResolvers = [...d.viewResolvers, ...d.xmlViewResolvers];
// ---- the template roots (RM48) -------------------------------------------
//
// WHICH ENGINE WROTE THIS MARKUP, when nothing in the configuration says. A
// `.html` under a template directory is a Thymeleaf template when it carries a
// `th:` attribute and an ordinary page when it does not, and a bounded read of
// the root's own files is the only thing that can tell them apart.
const engineMarkers = new Map();
const dirsUnder = (under) => [...templateDirs.keys()].filter((dir) => dir === under || dir.startsWith(`${under}/`)).sort();
const markRoots = (roots) => {
  for (const r of roots) {
    const seen = new Set();
    let filesRead = 0;
    for (const dir of dirsUnder(r)) {
      for (const absFile of templateSample.get(dir) ?? []) {
        if (filesRead >= TEMPLATE_MARKER_FILES) break;
        filesRead += 1;
        const text = read(absFile);
        if (text === null) continue;
        const head = text.slice(0, TEMPLATE_MARKER_BYTES);
        for (const spec of TEMPLATE_ENGINES) {
          if (spec.markers.some((m) => head.includes(m))) seen.add(spec.engine);
        }
      }
    }
    engineMarkers.set(r, seen);
  }
};
// Two passes: the roots first, then the markers over exactly those roots, then
// the engines again now that the markers are known. Reading the markers first
// would mean reading every candidate directory in the tree.
const provisional = templateRootsOf({ dirs: templateDirs, resolvers: viewResolvers });
markRoots(provisional.map((r) => r.root));
const templateRoots = templateRootsOf({ dirs: templateDirs, resolvers: viewResolvers, engineMarkers });
counts.templateFiles = templateRoots.reduce((n, r) => n + r.files, 0);

// SAID ONCE, not once per file. A `spring.config.import` pointing at a config
// server means part of this project's configuration lives somewhere this walk
// cannot see, so the service name and the gateway routes below are what the
// TREE says and may not be all the deployment says.
if (externalConfigImports.length > 0) {
  const files = [...new Set(externalConfigImports.map((i) => i.file))].sort();
  diagnostics.push({
    kind: 'CONFIG_IMPORTED_FROM_OUTSIDE_THE_TREE',
    severity: 'info',
    path: files[0],
    reason: `${files.length} Spring configuration file(s) import settings from outside this repository `
      + `(spring.config.import in ${files.slice(0, 3).join(', ')}${files.length > 3 ? `, and ${files.length - 3} more` : ''}). `
      + 'Nothing here reads a config server, so a service name or a gateway route declared only there is not in this discovery',
  });
}

  return templateRoots;
}


export function discover(root, io = {}) {
  const { readDir, readFile, gitHead } = io;
  const maxFiles = io.maxFiles ?? DEFAULT_MAX_FILES;
  if (typeof root !== 'string' || root.length === 0) {
    throw new DiscoverError('root must be a non-empty string');
  }
  for (const [name, fn] of [['readDir', readDir], ['readFile', readFile], ['gitHead', gitHead]]) {
    if (typeof fn !== 'function') throw new DiscoverError(`discover requires an injected ${name} function`);
  }

  const diagnostics = [];
  const counts = {
    javaFiles: 0,
    javaTestFiles: 0,
    springHandlerFiles: 0,
    mybatisMapperXml: 0,
    ddlFiles: 0,
    jpaEntityFiles: 0,
    mybatisPlusFiles: 0,
    kotlinFiles: 0,
    frontendPackageJson: 0,
    // The web lane's inputs (RM26): every source file it would read, and how
    // many of those are single-file components.
    webFiles: 0,
    vueFiles: 0,
  };
  // One entry per frontend package.json, with what its dependencies declare.
  const webPackages = [];
  // A FRONTEND WITH NO PACKAGE MANIFEST (RM47). Every directory that holds a
  // frontend source file with no package.json above it inside its repository,
  // with how many such files it holds; plus every `index.html` beside one, so
  // the page's own `<script src>` list can say which of those directories the
  // server really serves. The rule that turns these into roots runs after the
  // walk, because it needs the whole file list.
  const looseWebFiles = new Map(); // rel dir -> file count
  const looseWebPaths = new Set(); // rel file path
  const looseIndexPages = new Map(); // rel dir -> abs index.html
  // THE SERVER-RENDERED PAGES (RM48): every directory holding a file with a
  // template engine's extension, with how many of each, plus a bounded sample of
  // the files themselves so the engine can be read off the markup after the walk.
  const templateDirs = new Map(); // rel dir -> Map<ext, count>
  const templateSample = new Map(); // rel dir -> abs paths, at most a few
  const viewResolvers = [];
  const xmlViewResolvers = []; // …and the same settings written as Spring BEANS (RM55)
  // Every OpenAPI / Swagger document in the tree, with the version it declares.
  const openapiDocuments = [];
  const ddlPaths = [];
  // Every .sql that declares or amends a table, with its dialect and its role.
  const ddlCandidates = [];
  // Connection-info candidates (SPEC §12.1 ①). Discovery only LISTS them; it
  // never dials one, and it never reads a password value — src/core/dbconfig.mjs
  // returns references, not secrets.
  const connectionCandidates = [];
  const dbTypeDeclarations = []; // the vendor the configuration NAMES (RM55): Globals.DbType and its kin
  // What the project's own Spring configuration says about WHO it is and WHERE
  // it forwards a request (RM46, src/core/springconfig.mjs). Both used to be
  // typed into the profile by hand, and both are in the tree.
  const serviceNames = [];
  const gatewayRoutes = [];
  const externalConfigImports = [];
  // The two lane inputs `cascade analyze` needs when it is run with no flags:
  // which directories hold MyBatis mapper XML, and which directories are Java
  // source roots (measured from each file's own `package` declaration, never
  // assumed to be `src/main/java`).
  const mapperDirs = new Set();
  const javaRoots = new Set();
  const javaTestRoots = new Set();
  // repoRel -> per-repo tallies; the walk attributes each file to the deepest
  // enclosing repository so the manifest can give every repo an honest `kind`.
  const repoStats = new Map();
  const packageCounts = new Map();

  const rel = (abs) => {
    const r = path.relative(root, abs);
    return r === '' ? '.' : r.split(path.sep).join('/');
  };

  // The repository stack: the innermost entry owns the files being walked.
  // The walk's own counters: written by the walk, read by the answer.
  const w = { filesScanned: 0, capped: false, sawPom: false, sawGradle: false };
  // `classify` is handed over as a thunk because the walker calls it and the
  // classifiers need the state the walker's own `read` and `addRoot` go into.
  const walkers = { classify: (...a) => classify(...a) };
  const { walk, addRoot, read } = makeWalker(io, w, {
    classify: (...a) => walkers.classify(...a), diagnostics, javaRoots, javaTestRoots, maxFiles, rel, repoStats,
  });

  // The discovery STATE the classifiers write into. One object rather than
  // twenty closures, so a classifier can be read — and tested — on its own.
  const d = {
    addRoot,
    connectionCandidates,
    counts,
    dbTypeDeclarations,
    ddlCandidates,
    ddlDialectHint: null,
    ddlPaths,
    diagnostics,
    externalConfigImports,
    gatewayRoutes,
    javaWithPackage: 0,
    looseIndexPages,
    looseWebFiles,
    looseWebPaths,
    mapperDirs,
    openapiDocuments,
    packageCounts,
    read,
    root,
    serviceNames,
    templateDirs,
    templateSample,
    viewResolvers,
    webPackages,
    xmlViewResolvers,
  };
  const classify = (absFile, name, repoKey, dirEntries, inPackage) => {
    classifyFile(d, {
      absFile,
      name,
      lower: name.toLowerCase(),
      repoKey,
      dirEntries,
      inPackage,
      stats: repoKey === null ? null : repoStats.get(repoKey),
      rel,
    });
  };

  walk(root, [], true, false);

  const webVendoredRoots = looseWebRoots(d);
  const templateRoots = templateRootsFrom(d);

  const repos = [...repoStats.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return {
    root,
    repos,
    counts,
    buildTool: w.sawPom ? 'maven' : w.sawGradle ? 'gradle' : null,
    packagePrefixes: coveringPrefixes(packageCounts, d.javaWithPackage),
    mapperDirs: minimalRoots(mapperDirs),
    // The web lane's roots and packages (RM26). `minimalRoots` for the same
    // reason the mapper and java roots use it: the lane walks recursively, so
    // listing a directory and one of its children would read the child twice.
    webSourceRoots: minimalRoots(webPackages.map((p) => p.root)),
    webPackages: webPackages.slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    // The frontend roots that have no package manifest at all (RM47). Kept
    // apart from `webSourceRoots` on purpose: those come from a dependency list
    // that named a framework, these from where the files sit, and a reader has
    // to be able to tell the two apart.
    webVendoredRoots,
    // WHERE A VIEW NAME IS RESOLVED (RM48), with the engine that renders it and
    // the suffix the resolver appends. `cascade init` writes these to the
    // profile, where they become the user's to correct, exactly like `webRoots`.
    templateRoots,
    // …and what the configuration actually said, so a reader can see whether a
    // root came from a declared prefix or from where the files sit.
    viewResolvers: [...viewResolvers, ...xmlViewResolvers]
      .sort((a, b) => (a.engine < b.engine ? -1 : a.engine > b.engine ? 1 : a.file < b.file ? -1 : 1)),
    // Sorted by path, like every other list here: a walk's order must not decide
    // which document a run reads first.
    openapiDocuments: openapiDocuments.slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    javaSourceRoots: minimalRoots(javaRoots),
    javaTestRoots: minimalRoots(javaTestRoots),
    ddlPaths: ddlPaths.slice().sort(),
    // Sorted by path: "applied in path order" has to mean the same thing on
    // every machine, and a directory walk's order does not.
    ddlCandidates: ddlCandidates.slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    ddlDialectHint: d.ddlDialectHint,
    dbTypeDeclarations: dbTypeDeclarations.slice(), // what the configuration says the database IS (RM55)
    connectionCandidates: connectionCandidates
      .slice()
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.url < b.url ? -1 : a.url > b.url ? 1 : 0)),
    // Sorted for the same reason every other list here is: what a run reports
    // must not depend on the order a directory happened to be walked in.
    serviceNames: serviceNames.slice()
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.file < b.file ? -1 : a.file > b.file ? 1 : 0)),
    gatewayRoutes: gatewayRoutes.slice()
      .sort((a, b) => (a.front < b.front ? -1 : a.front > b.front ? 1 : a.file < b.file ? -1 : a.file > b.file ? 1 : 0)),
    externalConfigImports: externalConfigImports.slice()
      .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.value < b.value ? -1 : a.value > b.value ? 1 : 0)),
    filesScanned: Math.min(w.filesScanned, maxFiles),
    capped: w.capped,
    diagnostics,
  };
}

/**
 * Whether a root-relative path sits under the standard Maven/Gradle TEST source
 * layout — a `src/test/…` segment, at any depth (so `app/src/test/java` and
 * `modules/x/src/test` both match, while `src/main/java/.../testing/` does not).
 *
 * This is a LAYOUT CONVENTION the build tools document, not a guess about the
 * code: it decides only which roots an UNFLAGGED run reads by default, it is
 * printed on every run, and `--java-src <that root>` still analyzes it.
 *
 * @param {string} relPath  a POSIX path relative to the scanned root
 * @returns {boolean}
 */
export function isTestPath(relPath) {
  const p = String(relPath ?? '');
  return p === 'src/test' || p.startsWith('src/test/') || p.includes('/src/test/') || p.endsWith('/src/test');
}

/**
 * The Java source root a file belongs to: its directory with the package's own
 * segments removed, but ONLY when the directory really ends with those segments
 * (a file whose directory layout disagrees with its package keeps its own
 * directory — the engine does not invent a layout it did not see). Never climbs
 * above `stopAt`.
 *
 * @param {string} dir       absolute directory holding the .java file
 * @param {string} pkg       the declared package, e.g. "com.example.shop"
 * @param {string} stopAt    absolute scan root; the walk never rises above it
 * @returns {string} an absolute directory
 */
export function sourceRootOf(dir, pkg, stopAt) {
  const segs = pkg.split('.').filter(Boolean);
  let cur = dir;
  for (let i = segs.length - 1; i >= 0; i -= 1) {
    if (path.basename(cur) !== segs[i]) return dir; // layout disagrees with the package
    const up = path.dirname(cur);
    if (up === cur || !isWithin(stopAt, up)) return dir; // would leave the scanned tree
    cur = up;
  }
  return cur;
}

/**
 * Sorted, with every path that is a strict descendant of another path dropped:
 * `--mappers`/`--java-src` walk recursively, so listing both a directory and one
 * of its children would analyze the child's files twice.
 * @param {Iterable<string>} paths  root-relative POSIX paths ('.' for the root)
 * @returns {string[]}
 */
export function minimalRoots(paths) {
  const all = [...new Set(paths)].sort();
  return all.filter((p) => !all.some((q) => q !== p && (q === '.' || p.startsWith(q + '/'))));
}

function isWithin(rootAbs, candidate) {
  const r = path.resolve(rootAbs);
  const c = path.resolve(candidate);
  return c === r || c.startsWith(r + path.sep);
}

/**
 * The prefix a package declaration contributes: its first three segments, or the
 * whole package when it has fewer (a two-segment `com.example` stays as it is).
 * @param {string} pkg
 * @returns {string}
 */
export function prefixOf(pkg) {
  const parts = pkg.split('.');
  return parts.slice(0, 3).join('.');
}

/**
 * The minimal set of package prefixes covering >= 95% of the java files that
 * declare a package, sorted alphabetically. Empty when no java file declares one
 * — the engine never invents a default package prefix (SPEC §6, MUST NOT).
 * @param {Map<string, number>} packageCounts
 * @param {number} total  java files that carry a package declaration
 * @returns {string[]}
 */
export function coveringPrefixes(packageCounts, total) {
  if (total <= 0 || packageCounts.size === 0) return [];
  // Greedy by descending count (ties broken by name, for determinism) until the
  // covered share reaches the threshold — that is the minimal covering set.
  const ranked = [...packageCounts.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1));
  const need = total * PREFIX_COVERAGE;
  const chosen = [];
  let covered = 0;
  for (const [prefix, n] of ranked) {
    if (covered >= need) break;
    chosen.push(prefix);
    covered += n;
  }
  return chosen.sort();
}

export class DiscoverError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DiscoverError';
  }
}
