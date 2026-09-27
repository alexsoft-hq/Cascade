// nest_routes.mjs — the routes a NestJS application serves: the controllers its modules register, under its global prefix and version.
//
// A controller class is not a route by existing. It serves only when a module
// the application loads lists it, starting from the module the bootstrap hands
// `NestFactory.create`, through each module's `imports`. The application is the
// one the bootstrap then `listen`s on (ghostfolio makes a first one only to read
// its configuration and closes it). Its `setGlobalPrefix` goes before every
// route, and `enableVersioning` of the URI type puts the version after that.
// A module `RouterModule.register` names a path puts that path before the
// routes of the controllers the module declares.
//
// WHAT IS NOT KNOWN MAKES NO ROUTE. A prefix, a version or a path the source
// holds in a variable, a module list built by a condition: the route it would
// give could be wrong, so none is made, and the reason is a diagnostic. A
// route made anyway would be a confident answer about an address that may not
// exist. The names these calls go by are the rule's (src/core/rules/packs/nestjs.json).

import { joinRoute, versionsOf } from '../../core/rules/kinds/ts_route_decorator.mjs';

const MAX_MODULES = 2000;
// A route pattern (`cats/*`, `{/*wildcard}`, `:id`) is matched by the
// framework's own path matcher; only a plain path is compared here.
const PATTERN_CHARS = /[*:{}()?+]/;

/** Calls of one member, by the callee as written. */
function callsIn(project, file, where) {
  return project.calls.filter((c) => c.file === file && c.in === where);
}

/**
 * The application the bootstrap serves: the `create` call whose holder then
 * calls `listen`. With one `create` and no `listen` seen, that one.
 */
function servedApp(project, app, diagnostics) {
  const creates = project.calls.filter((c) => c.callee === app.create);
  const served = creates.filter((c) => c.holder && callsIn(project, c.file, c.in).some((x) => x.callee === `${c.holder}.${app.listen}`));
  const pick = served.length === 1 ? served[0] : creates.length === 1 ? creates[0] : null;
  if (!pick) diagnostics.push({ kind: 'TS_APP_NOT_FOUND', reason: creates.length === 0 ? `no call of ${app.create} was found, so no controller is known to be served` : `${creates.length} calls of ${app.create} and ${served.length} of them listen: which application serves is not decided, so no route is made` });
  return pick;
}

function configOf(project, boot, app, name) {
  const calls = boot.holder ? callsIn(project, boot.file, boot.in).filter((c) => c.callee === `${boot.holder}.${name}`) : [];
  return calls.length === 0 ? { absent: true } : { args: calls[calls.length - 1].args };
}

/** The routes a global prefix's `exclude` option names as plain paths; a pattern or a computed entry is said, not guessed. */
function excludesOf(opts, prefix, notes) {
  const exclude = opts && opts.k === 'obj' && opts.v.exclude && opts.v.exclude.k === 'arr' ? opts.v.exclude : null;
  const literal = exclude ? exclude.v.filter((e) => e.k === 'str' && !PATTERN_CHARS.test(e.v)).map((e) => joinRoute(e.v)) : [];
  const unread = exclude ? exclude.v.length - literal.length + (exclude.spread ? 1 : 0) : 0;
  if (unread > 0) notes.push({ kind: 'TS_PREFIX_EXCLUDE_UNREAD', reason: `the global prefix "${prefix}" excludes ${unread} route pattern(s) not written as plain literal paths; a route one of them names is served without the prefix, and is shown here with it` });
  return literal;
}

/**
 * The global prefix: the profile's `tsBackend.globalPrefix` when it declares
 * one (the deployed value, which a prefix read from configuration only names),
 * else the literal the bootstrap sets, `''` when it sets none, and null when it
 * sets something not written as a literal.
 */
function prefixOf(project, boot, app, notes, declared) {
  const cfg = configOf(project, boot, app, app.globalPrefix);
  const [p, opts] = cfg.absent ? [] : cfg.args;
  const written = cfg.absent ? '' : p && p.k === 'str' ? p.v : null;
  const prefix = declared ?? written;
  if (prefix === null) return null;
  if (declared != null && written !== null && written !== declared) {
    notes.push({ kind: 'TS_PREFIX_DECLARED', reason: `the profile's tsBackend.globalPrefix "${declared}" is used, and the bootstrap sets "${written}"` });
  }
  return { prefix, exclude: excludesOf(opts, prefix, notes) };
}

/** URI versioning: `{uri:false}` when there is none, `{uri, prefix, defaultVersion}` when it is literal, null when not. */
function versioningOf(project, boot, app) {
  const cfg = configOf(project, boot, app, app.versioning);
  if (cfg.absent) return { uri: false };
  const opts = cfg.args[0];
  if (!opts || opts.k !== 'obj' || opts.spread) return null;
  const type = opts.v.type;
  if (!type || type.k !== 'member') return null;
  if (type.v !== app.uriType) return { uri: false };
  const defaultVersion = versionsOf(opts.v.defaultVersion, app.neutral);
  if (defaultVersion?.unread) return null;
  const prefix = opts.v.prefix === undefined ? app.uriPrefix : opts.v.prefix.k === 'str' ? opts.v.prefix.v : null;
  if (prefix === null) return null;
  return { uri: true, prefix, defaultVersion };
}

/** A module list entry's module class: a name, `X.forRoot(...)`, or `forwardRef(() => X)`. */
function moduleClassOf(project, file, value) {
  if (!value) return null;
  if (value.k === 'id') return project.classOf(file, value.v);
  if (value.k === 'call' && value.callee && value.callee.includes('.')) return project.classOf(file, value.callee.split('.')[0]);
  if (value.k === 'call' && value.args.length === 1 && value.args[0].k === 'fn' && value.args[0].returns) return moduleClassOf(project, file, value.args[0].returns);
  return null;
}

/**
 * Whether a module list entry is a package's module (`ConfigModule`,
 * `JwtModule.register(...)`): the package's own code is not read, so neither
 * are the routes it may serve, and that is no failure to read this project.
 */
function isPackageModule(project, file, value) {
  const name = value.k === 'id' ? value.v : value.k === 'call' && value.callee?.includes('.') ? value.callee.split('.')[0] : null;
  return name !== null && Boolean(project.meaning(file, name)?.external);
}

/**
 * The paths `RouterModule.register([{ path, module, children }])` gives
 * modules, into `out` by module key. A child written as a module alone takes
 * its parent's path. False when any of it is not written as literals.
 */
function readModulePaths(project, file, list, parent, out) {
  if (!list || list.k !== 'arr' || list.spread) return false;
  let whole = true;
  for (const entry of list.v) {
    if (entry.k === 'id') {
      const cls = project.classOf(file, entry.v);
      if (cls) out.set(cls.key, parent); else whole = false;
      continue;
    }
    const path = entry.k === 'obj' && !entry.spread ? pathOfTree(entry.v.path) : null;
    if (path === null) { whole = false; continue; }
    const here = joinRoute(parent, path);
    const mod = entry.v.module ? moduleClassOf(project, file, entry.v.module) : null;
    if (entry.v.module && !mod) whole = false;
    if (mod) out.set(mod.key, here);
    if (entry.v.children && !readModulePaths(project, file, entry.v.children, here, out)) whole = false;
  }
  return whole;
}

const pathOfTree = (v) => (v === undefined ? '' : v.k === 'str' ? v.v : null);

/**
 * Every controller the modules reachable from `root` register, each with the
 * module that declares it, the module paths `RouterModule.register` gives, and
 * what could not be read on the way. `modulePathsRead` is false when a
 * `RouterModule.register` was not written as literals.
 */
function registeredControllers(project, compiled, root, diagnostics) {
  const seen = new Set();
  const queue = [root];
  const controllers = new Map();
  const modulePaths = new Map();
  let modulePathsRead = true;
  while (queue.length > 0 && seen.size < MAX_MODULES) {
    const mod = queue.shift();
    if (seen.has(mod.key)) continue;
    seen.add(mod.key);
    const decl = compiled.moduleOf(mod);
    if (!decl) continue;
    if (!decl.readable) diagnostics.push({ kind: 'TS_MODULE_UNREAD', reason: `${mod.key}: its module options are not an object literal, so what it imports and registers is not known` });
    for (const v of decl.imports.v) {
      if (v.k === 'call' && v.callee === compiled.app.routerModule) {
        if (!readModulePaths(project, mod.file, v.args[0], '', modulePaths)) modulePathsRead = false;
        continue;
      }
      const target = moduleClassOf(project, mod.file, v);
      if (target) queue.push(target);
      else if (!isPackageModule(project, mod.file, v)) {
        const what = v.k === 'id' ? `the import ${v.v} is a value, not a module class` : `an import of kind ${v.k} is not a module class this engine can name`;
        diagnostics.push({ kind: 'TS_MODULE_IMPORT_UNREAD', reason: `${mod.key}: ${what}, so the controllers the module it holds registers are not served here` });
      }
    }
    if (decl.imports.spread) diagnostics.push({ kind: 'TS_MODULE_IMPORT_UNREAD', reason: `${mod.key}: its imports spread a list, so the modules in it are not known` });
    for (const v of decl.controllers.v) {
      const cls = v.k === 'id' ? project.classOf(mod.file, v.v) : null;
      if (cls) controllers.set(cls.key, { cls, module: mod.key });
    }
  }
  return { controllers: [...controllers.values()], modulePaths, modulePathsRead };
}

/** The version segments a route is served under: '' for none or the neutral version, null when its version is not known. */
function versionSegments(versioning, routeVersion) {
  if (!versioning.uri) return [''];
  const v = routeVersion ?? versioning.defaultVersion;
  if (!v) return [''];
  if (v.unread) return null;
  return [...new Set(v.versions.map((x) => (x === null ? '' : `${versioning.prefix}${x}`)))];
}

function routesOfController(compiled, entry, ctx) {
  const { prefix, versioning, modulePaths, diagnostics } = ctx;
  const { cls } = entry;
  const ctl = compiled.controllerOf(cls);
  if (!ctl) return [];
  return compiled.routesOf(cls, ctl).flatMap((r) => {
    const segments = versionSegments(versioning, r.version);
    if (r.path === null || segments === null) {
      const what = r.path === null ? 'its path' : 'its version';
      diagnostics.push({ kind: r.path === null ? 'TS_ROUTE_PATH_UNREAD' : 'TS_ROUTE_VERSION_UNREAD', reason: `${cls.key}.${r.method}: ${what} is not written as a literal, so no route is made for it` });
      return [];
    }
    const own = joinRoute(modulePaths.get(entry.module) ?? '', r.path);
    const head = prefix.exclude.includes(own) ? '' : prefix.prefix;
    return segments.map((segment) => ({
      verb: r.verb, path: joinRoute(head, segment, own), file: cls.file, cls: cls.name, method: r.method, line: r.line, rule: compiled.rule,
    }));
  });
}

/**
 * THE ROUTES the application serves, each with its handler, and every reason a
 * route could not be made. `unregistered` is null when the application itself
 * could not be read, so which controllers it registers was never asked.
 *
 * @param {object} project  readProject's answer
 * @param {object} compiled  the ts.route-decorator rule, compiled
 * @param {{globalPrefix?:(string|null)}} [declared]  what the profile says the source cannot
 * @returns {{routes:object[], diagnostics:object[], controllers:number, unregistered:(string[]|null)}}
 */
export function nestRoutes(project, compiled, declared = {}) {
  const diagnostics = [];
  const app = compiled.app;
  const boot = app ? servedApp(project, app, diagnostics) : null;
  const root = boot ? moduleClassOf(project, boot.file, boot.args[0]) : null;
  if (boot && !root) diagnostics.push({ kind: 'TS_ROOT_MODULE_UNREAD', reason: `${boot.file}:${boot.line}: the module handed to ${app.create} is not a class of this project` });
  const prefix = boot ? prefixOf(project, boot, app, diagnostics, declared.globalPrefix ?? null) : null;
  const versioning = boot ? versioningOf(project, boot, app) : null;
  if (boot && prefix === null) diagnostics.push({ kind: 'TS_PREFIX_UNREAD', reason: `${boot.file}: the global prefix is not written as a literal, so no route's address is known. Declare the deployed one as tsBackend.globalPrefix in the profile` });
  if (boot && versioning === null) diagnostics.push({ kind: 'TS_VERSIONING_UNREAD', reason: `${boot.file}: the versioning options are not written as literals, so no route's address is known` });
  const allControllers = [...project.files.values()].flatMap((f) => [...f.classes.values()]).filter((c) => compiled.controllerOf(c));
  if (!root || prefix === null || versioning === null) return { routes: [], diagnostics, controllers: allControllers.length, unregistered: null };
  const registered = registeredControllers(project, compiled, root, diagnostics);
  const keys = new Set(registered.controllers.map((c) => c.cls.key));
  const unregistered = allControllers.filter((c) => !keys.has(c.key)).map((c) => c.key).sort();
  if (!registered.modulePathsRead) {
    diagnostics.push({ kind: 'TS_ROUTER_MODULE_UNREAD', reason: `the module paths ${app.routerModule} gives are not all written as literals, so no route's address is known` });
    return { routes: [], diagnostics, controllers: allControllers.length, unregistered };
  }
  const ctx = { prefix, versioning, modulePaths: registered.modulePaths, diagnostics };
  return {
    routes: registered.controllers.flatMap((entry) => routesOfController(compiled, entry, ctx)),
    diagnostics,
    controllers: allControllers.length,
    unregistered,
  };
}
