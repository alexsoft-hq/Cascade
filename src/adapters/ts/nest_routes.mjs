// nest_routes.mjs — the routes a NestJS application serves: the controllers its modules register, under its global prefix and version.
//
// A controller class is not a route by existing. It serves only when a module
// the application loads lists it, starting from the module the bootstrap hands
// `NestFactory.create`, through each module's `imports`. The bootstrap's
// prefix, excludes and versioning are read in src/adapters/ts/nest_app.mjs;
// a module `RouterModule.register` names a path puts that path before the
// routes of the controllers the module declares.
//
// A class is read as Nest reads it: a decorator by the name its package gives
// it (`import { Controller as Ctl }` is Controller, one of the project's own
// named Controller is not), and the route methods it inherits from classes of
// the project beside its own, as Nest's scan of the prototype chain finds them.
//
// WHAT IS NOT KNOWN MAKES NO ROUTE. A prefix, a version or a path the source
// holds in a variable, a module list a spread may replace: the route it would
// give could be wrong, so none is made, and the reason is a diagnostic. A route
// whose address holds only if no unread exclude names it is made at the
// address it has otherwise and graded HEURISTIC. The names these calls go by
// are the rule's (src/core/rules/packs/nestjs.json).

import { joinRoute } from '../../core/rules/kinds/ts_route_decorator.mjs';
import { readApplication } from './nest_app.mjs';
import { nestPathOf } from './route_pattern.mjs';

const MAX_MODULES = 2000;

/** The name a decorator has in its package; null for one of the project's own, or another package's; one this engine cannot trace keeps its written name. */
function frameworkName(project, file, written, packages) {
  const [head, ...rest] = written.split('.');
  const ns = project.files.get(file)?.imports.find((i) => i.namespace === head);
  if (ns) return packages.includes(ns.source) && rest.length > 0 ? rest.join('.') : null;
  if (rest.length > 0) return written;
  const m = project.meaning(file, head);
  if (!m) return written;
  return m.external && packages.includes(m.external) ? m.name : null;
}

export function decoratorsIn(project, file, decorators, packages) {
  return decorators.map((d) => ({ ...d, name: frameworkName(project, file, d.name, packages) })).filter((d) => d.name !== null);
}

/**
 * A class as the rule reads it: its decorators by their package names, and its
 * methods with those it inherits from classes of the project, the nearest
 * declaration of each name winning. Each method keeps the class that declares it.
 */
function classView(project, cls, packages) {
  const methods = new Map();
  for (const c of project.lineage(cls)) {
    for (const [name, m] of c.methods) if (!methods.has(name)) methods.set(name, { ...m, decorators: decoratorsIn(project, c.file, m.decorators, packages) });
  }
  return { ...cls, decorators: decoratorsIn(project, cls.file, cls.decorators, packages), methods };
}

export function viewsOf(project, compiled) {
  const views = new Map();
  const viewOf = (cls) => {
    if (!views.has(cls.key)) views.set(cls.key, classView(project, cls, compiled.packages));
    return views.get(cls.key);
  };
  return viewOf;
}

/** A module list entry's module class: a name, `X.forRoot(...)`, or `forwardRef(() => X)`. */
export function moduleClassOf(project, file, value) {
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
export function isPackageModule(project, file, value) {
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

/** One module's imports: the modules to walk next, and the paths a `RouterModule.register` among them gives. False when that is not read. */
function walkImports(project, compiled, mod, decl, ctx) {
  const { queue, modulePaths, diagnostics } = ctx;
  let read = true;
  for (const v of decl.imports.v) {
    if (v.k === 'call' && v.callee === compiled.app.routerModule) {
      if (!readModulePaths(project, mod.file, v.args[0], '', modulePaths)) read = false;
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
  return read;
}

/**
 * Every controller the modules reachable from `root` register, each with the
 * module that declares it, the module paths `RouterModule.register` gives, and
 * what could not be read on the way. A module whose options this engine cannot
 * read registers nothing here: a spread may replace the lists written beside it.
 */
function registeredControllers(project, compiled, viewOf, root, diagnostics) {
  const seen = new Set();
  const queue = [root];
  const controllers = new Map();
  const modulePaths = new Map();
  let modulePathsRead = true;
  while (queue.length > 0 && seen.size < MAX_MODULES) {
    const mod = queue.shift();
    if (seen.has(mod.key)) continue;
    seen.add(mod.key);
    const decl = compiled.moduleOf(viewOf(mod));
    if (!decl) continue;
    if (!decl.readable) {
      diagnostics.push({ kind: 'TS_MODULE_UNREAD', reason: `${mod.key}: its module options are not an object literal this engine can read whole, so what it imports and registers is not known and none of it is served here` });
      continue;
    }
    if (!walkImports(project, compiled, mod, decl, { queue, modulePaths, diagnostics })) modulePathsRead = false;
    if (decl.controllers.spread) diagnostics.push({ kind: 'TS_MODULE_UNREAD', reason: `${mod.key}: its controllers spread a list, so the controllers in it are not served here` });
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

/** Where the global prefix goes for one route: none when an exclude names it, and whether that rests on no unread exclude naming it. */
function prefixFor(prefix, verb, own) {
  const nestPath = nestPathOf(own);
  const excluded = prefix.matchers.some((m) => (m.verb === 'ANY' || m.verb === verb) && m.test.test(nestPath));
  if (excluded || prefix.prefix === '') return { head: excluded ? '' : prefix.prefix, uncertain: false };
  return { head: prefix.prefix, uncertain: prefix.unreadExcludes > 0 };
}

function routesOfController(compiled, entry, ctx) {
  const { prefix, versioning, modulePaths, diagnostics, viewOf } = ctx;
  const view = viewOf(entry.cls);
  const ctl = compiled.controllerOf(view);
  if (!ctl) return [];
  return compiled.routesOf(view, ctl).flatMap((r) => {
    const segments = versionSegments(versioning, r.version);
    if (r.path === null || segments === null) {
      const what = r.path === null ? 'its path' : 'its version';
      diagnostics.push({ kind: r.path === null ? 'TS_ROUTE_PATH_UNREAD' : 'TS_ROUTE_VERSION_UNREAD', reason: `${entry.cls.key}.${r.method}: ${what} is not written as a literal, so no route is made for it` });
      return [];
    }
    const own = joinRoute(modulePaths.get(entry.module) ?? '', r.path);
    const { head, uncertain } = prefixFor(prefix, r.verb, own);
    return segments.map((segment) => ({
      verb: r.verb, path: joinRoute(head, segment, own), ownPath: own, file: r.file, cls: r.cls, method: r.method, line: r.line, rule: compiled.rule,
      ...(uncertain ? { grade: 'HEURISTIC', uncertain: `the global prefix "${prefix.prefix}" excludes ${prefix.unreadExcludes} route pattern(s) this engine cannot read; if one names this route it is served without the prefix` } : {}),
    }));
  });
}

/**
 * The classes whose methods declare routes and that no controller decorator
 * marks, nor any controller extends: a decorator of the project's own that
 * wraps Controller is not read, so their routes are not served here, and that
 * is said.
 */
function unmarkedRouteClasses(project, compiled, viewOf, controllers) {
  const inherited = new Set(controllers.flatMap((c) => project.lineage(c).map((x) => x.key)));
  return [...project.files.values()].flatMap((f) => [...f.classes.values()])
    .filter((c) => !inherited.has(c.key) && compiled.declaresRoutes(viewOf(c)))
    .map((c) => ({ kind: 'TS_ROUTES_WITHOUT_CONTROLLER', reason: `${c.key}: its methods declare routes and no controller decorator the rule names marks it or a class extending it, so they are not served here` }));
}

/**
 * THE ROUTES the application serves, each with its handler, and every reason a
 * route could not be made. A route's `ownPath` is its module path (RouterModule),
 * its controller's and its method's own path, before the version and the global
 * prefix: the part a deployment does not decide, which the bridge groups routes
 * by. A module path is a part of the application it chose itself (`admin`,
 * `public`), so it is the group, never the deployment. `unregistered` is null when the application itself
 * could not be read, so which controllers it registers was never asked.
 *
 * @param {object} project  readProject's answer
 * @param {object} compiled  the ts.route-decorator rule, compiled
 * @param {{globalPrefix?:(string|null), globalPrefixExclude?:(string[]|null)}} [declared]  what the profile says the source cannot
 * @returns {{routes:object[], diagnostics:object[], controllers:number, unregistered:(string[]|null), root:(object|null)}}
 */
export function nestRoutes(project, compiled, declared = {}) {
  const diagnostics = [];
  const viewOf = viewsOf(project, compiled);
  const allControllers = [...project.files.values()].flatMap((f) => [...f.classes.values()]).filter((c) => compiled.controllerOf(viewOf(c)));
  diagnostics.push(...unmarkedRouteClasses(project, compiled, viewOf, allControllers));
  const application = compiled.app ? readApplication(project, compiled.app, declared, diagnostics) : null;
  const root = application ? moduleClassOf(project, application.boot.file, application.boot.args[0]) : null;
  if (application && !root) diagnostics.push({ kind: 'TS_ROOT_MODULE_UNREAD', reason: `${application.boot.file}:${application.boot.line}: the module handed to ${compiled.app.create} is not a class of this project` });
  // The root module is handed on: which classes the modules bind to a type is read from it too (nest_providers.mjs).
  const unknown = { routes: [], diagnostics, controllers: allControllers.length, unregistered: null, root };
  if (!root || application.prefix.unread || application.versioning.unread) return unknown;
  const registered = registeredControllers(project, compiled, viewOf, root, diagnostics);
  const keys = new Set(registered.controllers.map((c) => c.cls.key));
  const unregistered = allControllers.filter((c) => !keys.has(c.key)).map((c) => c.key).sort();
  if (!registered.modulePathsRead) {
    diagnostics.push({ kind: 'TS_ROUTER_MODULE_UNREAD', reason: `the module paths ${compiled.app.routerModule} gives are not all written as literals, so no route's address is known` });
    return { ...unknown, unregistered };
  }
  const ctx = { prefix: application.prefix, versioning: application.versioning, modulePaths: registered.modulePaths, diagnostics, viewOf };
  return { routes: registered.controllers.flatMap((entry) => routesOfController(compiled, entry, ctx)), diagnostics, controllers: allControllers.length, unregistered, root };
}
