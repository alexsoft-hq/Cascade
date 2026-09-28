// ts_route_decorator.mjs — the `ts.route-decorator` rule kind: which decorators make a TypeScript class a controller and a method a route.
//
// `@Controller('access')` on a class and `@Delete(':id')` on its method make the
// route `DELETE /access/{id}`. This kind knows HOW such decorators are read: the
// class decorator's path (a string, or the `path` of an object), a method
// decorator's path, the version a decorator or the controller's `version` names,
// and how the pieces join. The rule packs say WHICH decorator names mean what
// (src/core/rules/packs/nestjs.json).
//
// It reads one class on its own. Whether the class is registered in the
// application, and under which global prefix and version, is the bridge's
// question (src/adapters/ts/nest_routes.mjs): a controller no module registers
// serves nothing.

const NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const VERB = /^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|ANY)$/;
const UNKNOWN = '<unknown>';
const unknownKeys = (obj, allowed) => Object.keys(obj).filter((k) => !allowed.includes(k));

/**
 * A path as the route index spells one: joined with single slashes, a leading
 * slash, no trailing one, and `:id` written `{id}`.
 */
export function joinRoute(...parts) {
  const joined = `/${parts.filter((p) => p !== '').join('/')}`.replace(/\/+/g, '/');
  const trimmed = joined.length > 1 ? joined.replace(/\/$/, '') : joined;
  return trimmed.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

/** A decorator argument that is a path: a string gives it, nothing gives '', anything else is not known (null). */
function pathOf(arg) {
  if (!arg || arg.k === 'none') return '';
  if (arg.k === 'str') return arg.v;
  // A spread in the options may set the path, so no key written beside it decides it.
  if (arg.k === 'obj') return arg.spread || arg.computed ? null : arg.v.path ? pathOf(arg.v.path) : '';
  return null;
}

/**
 * The versions a @Version argument, a controller's `version` option or a
 * `defaultVersion` names: `{versions}`, a list in which null stands for the
 * neutral version, `{unread: true}` when they are not written as literals, and
 * null when none is written. One version or a list of them, as Nest takes both.
 */
export function versionsOf(arg, neutral) {
  if (!arg || arg.k === 'none' || arg.k === 'undefined') return null;
  const one = (v) => {
    if (v.k === 'str') return v.v;
    const isNeutral = (v.k === 'id' || v.k === 'member') && (v.v === neutral || v.v.endsWith(`.${neutral}`));
    return isNeutral ? null : undefined;
  };
  const list = arg.k !== 'arr' ? [arg] : arg.spread ? null : arg.v;
  const versions = list ? list.map(one) : null;
  return versions && versions.length > 0 && !versions.includes(undefined) ? { versions } : { unread: true };
}

/** The `version` of a controller's options object; a string argument is its path, not a version. A spread may set one. */
function optionsVersionOf(arg, neutral) {
  if (!arg || arg.k !== 'obj') return null;
  if (arg.spread || arg.computed) return { unread: true };
  return Object.hasOwn(arg.v, 'version') ? versionsOf(arg.v.version, neutral) : null;
}

const APP_KEYS = Object.freeze(['create', 'listen', 'globalPrefix', 'versioning', 'uriType', 'uriPrefix', 'neutral', 'routerModule']);

/** How an application is started and configured: each a name as the source writes it. */
function appErrors(app) {
  if (app === undefined) return [];
  if (!app || typeof app !== 'object' || Array.isArray(app)) return ['params.app must be an object'];
  const errors = unknownKeys(app, [...APP_KEYS, 'requestMethods']).map((k) => `params.app has an unknown key "${k}"`);
  for (const k of APP_KEYS) if (typeof app[k] !== 'string') errors.push(`params.app.${k} must be a name as the source writes it`);
  const methods = app.requestMethods;
  if (!methods || typeof methods !== 'object' || Array.isArray(methods)
    || Object.entries(methods).some(([name, verb]) => typeof name !== 'string' || typeof verb !== 'string' || !VERB.test(verb))) {
    errors.push('params.app.requestMethods must map a request method as the source writes it (RequestMethod.GET) to an HTTP verb (or ANY)');
  }
  return errors;
}

/** The packages the decorators are imported from, so one of the project's own of the same name is not taken for them. */
function packagesErrors(packages) {
  return Array.isArray(packages) && packages.length > 0 && packages.every((p) => typeof p === 'string' && p !== '')
    ? [] : ['params.packages must list the packages the decorators are imported from'];
}

function validateParams(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return ['params must be an object'];
  const errors = unknownKeys(params, ['controller', 'module', 'version', 'verbs', 'app', 'packages']).map((k) => `params has an unknown key "${k}"`);
  errors.push(...appErrors(params.app), ...packagesErrors(params.packages));
  if (typeof params.controller !== 'string' || !NAME.test(params.controller)) errors.push('params.controller must be a decorator name');
  if (typeof params.module !== 'string' || !NAME.test(params.module)) errors.push('params.module must be a decorator name');
  if (params.version !== undefined && (typeof params.version !== 'string' || !NAME.test(params.version))) errors.push('params.version must be a decorator name');
  if (!params.verbs || typeof params.verbs !== 'object' || Object.keys(params.verbs).length === 0) return [...errors, 'params.verbs must map decorator names to HTTP verbs'];
  for (const [name, verb] of Object.entries(params.verbs)) {
    if (!NAME.test(name) || typeof verb !== 'string' || !VERB.test(verb)) errors.push(`params.verbs has ${JSON.stringify(name)}: ${JSON.stringify(verb)}, which is not a decorator name and an HTTP verb (or ANY)`);
  }
  return errors;
}

function validateExample(example) {
  if (!example || typeof example !== 'object' || Array.isArray(example)) return ['an example must be an object'];
  const errors = unknownKeys(example, ['source', 'expect', 'why']).map((k) => `an example has an unknown key "${k}"`);
  if (typeof example.source !== 'string' || example.source.trim() === '') errors.push('an example needs a TypeScript "source"');
  if (!Array.isArray(example.expect)) return [...errors, 'an example needs "expect", the routes its source declares (empty for none)'];
  example.expect.forEach((e, i) => {
    const versionOk = e?.version === undefined || e.version === UNKNOWN
      || (Array.isArray(e.version) && e.version.length > 0 && e.version.every((v) => typeof v === 'string'));
    if (!e || typeof e.class !== 'string' || typeof e.method !== 'string' || !VERB.test(e.verb ?? '') || typeof e.path !== 'string'
      || !versionOk || unknownKeys(e, ['class', 'method', 'verb', 'path', 'version']).length > 0) {
      errors.push(`expect[${i}] must be {class, method, verb, path} with an optional version, a list of versions or "${UNKNOWN}"`);
    }
  });
  return errors;
}

/**
 * The rule, ready to read class records: `controllerOf(cls)` gives the class's
 * own path and version when it is a controller (null when not, `path: null`
 * when its path is not a literal), `routesOf(cls, controller)` the routes of
 * its methods, each with its path under the controller's, not yet under any
 * global prefix, and `moduleOf(cls)` the imports and controllers a module class
 * declares, as written (null when it is not a module).
 */
const listOf = (v) => (v && v.k === 'arr' ? v : v ? { k: 'arr', v: [v] } : { k: 'arr', v: [] });

/**
 * What a module decorator declares: its imports and controllers as written.
 * `@Module()` with no options is an empty module; options it cannot read (a
 * variable, a spread that may replace a list) register nothing it can name.
 */
function moduleReader(module) {
  return (cls) => {
    const d = cls.decorators.find((x) => x.name === module);
    if (!d) return null;
    const arg = d.args[0];
    const opts = arg && arg.k === 'obj' ? arg : null;
    const readable = !arg || (Boolean(opts) && !opts.spread && !opts.computed);
    return { imports: listOf(opts?.v.imports), controllers: listOf(opts?.v.controllers), readable };
  };
}

/** The routes a controller's methods declare, each under the controller's path, with the class that declares the method. */
function routeReader(rule, decoratorVersion) {
  const { verbs } = rule.params;
  return (cls, ctl) => [...cls.methods.values()].flatMap((m) => m.decorators
    .filter((d) => Object.hasOwn(verbs, d.name))
    .map((d) => {
      const own = pathOf(d.args[0]);
      const full = ctl.path === null || own === null ? null : joinRoute(ctl.path, own);
      return {
        method: m.name, file: m.file, cls: m.class, verb: verbs[d.name], path: full,
        version: decoratorVersion(m.decorators) ?? ctl.version, line: m.line, rule: rule.id,
      };
    }));
}

function compile(rule) {
  const { controller, module, version, verbs } = rule.params;
  const neutral = rule.params.app?.neutral ?? null;
  const moduleOf = moduleReader(module);
  const decoratorVersion = (decorators) => {
    const d = decorators.find((x) => x.name === version);
    return d ? versionsOf(d.args[0], neutral) : null;
  };
  const controllerOf = (cls) => {
    const d = cls.decorators.find((x) => x.name === controller);
    if (!d) return null;
    return { path: pathOf(d.args[0]), version: optionsVersionOf(d.args[0], neutral) ?? decoratorVersion(cls.decorators), rule: rule.id };
  };
  const routesOf = routeReader(rule, decoratorVersion);
  // Whether any method carries a route decorator: a class that does and is no
  // controller is one whose routes this rule cannot place.
  const declaresRoutes = (cls) => [...cls.methods.values()].some((m) => m.decorators.some((d) => Object.hasOwn(verbs, d.name)));
  return { controllerOf, routesOf, moduleOf, declaresRoutes, app: rule.params.app ?? null, packages: rule.params.packages, rule: rule.id };
}

/** A route's versions in an example's words: each as written, the neutral one by its name. */
const versionWords = (v, app) => (v.unread ? UNKNOWN : v.versions.map((x) => x ?? app?.neutral ?? 'neutral'));

/** Each class of an example read from its records, as the bridge reads one. */
function classesOf(records) {
  const classes = new Map();
  for (const r of records) if (r.kind === 'class') classes.set(r.name, { ...r, methods: new Map() });
  for (const r of records) if (r.kind === 'method' && classes.has(r.class)) classes.get(r.class).methods.set(r.name, r);
  return [...classes.values()];
}

const canonical = (list) => JSON.stringify([...list].map((e) => JSON.stringify(e, Object.keys(e).sort())).sort());

/** What one example's classes declare under the rule, in the example's own words. */
function routesOfExample(compiled, records) {
  return classesOf(records).flatMap((cls) => {
    const ctl = compiled.controllerOf(cls);
    return ctl ? compiled.routesOf(cls, ctl).map((r) => ({
      class: cls.name, method: r.method, verb: r.verb, path: r.path ?? UNKNOWN, ...(r.version ? { version: versionWords(r.version, compiled.app) } : {}),
    })) : [];
  });
}

/**
 * Every example read by the TypeScript worker's own file reader
 * (`env.tsFacts(name, source)`), in process: a TypeScript example needs no
 * toolchain beyond the engine's.
 */
function runExamples(entries, env) {
  if (!env || typeof env.tsFacts !== 'function') return { notRun: 'no TypeScript reader was handed in' };
  const results = new Map(entries.map((entry) => [entry.id, entry.rule.examples.map((ex, i) => {
    const got = routesOfExample(entry.compiled, env.tsFacts(`${entry.id}/example${i}.ts`, ex.source));
    return { example: ex, passed: canonical(got) === canonical(ex.expect), got };
  })]));
  return { results };
}

export const tsRouteDecorator = Object.freeze({
  name: 'ts.route-decorator',
  lane: 'ts',
  stage: 'ts-facts',
  // A route written in a decorator's literal is what the framework serves.
  gradeCap: 'EXACT',
  validateParams,
  validateExample,
  compile,
  runExamples,
});
