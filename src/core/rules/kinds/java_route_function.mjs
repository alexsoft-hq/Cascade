// java_route_function.mjs — the `java.route-function` rule kind: which calls in a Java method that returns a RouterFunction declare a route.
//
// Spring's functional endpoints declare routes with calls:
//
//   @Bean RouterFunction<ServerResponse> routes(OwnerHandler handler) {
//     return route().nest(path("/owners"), b -> b.GET("/{id}", handler::show)).build();
//   }
//
// This kind knows HOW such a method is read: a builder is started, a verb call
// adds a route (a path, a predicate, a handler, and springdoc's operation
// consumer), a nest puts routes under a prefix, a combining call adds another
// router function's routes, a filter leaves them as they were. The rule packs
// say WHICH names do which, and which argument is which (src/core/rules/packs/
// spring-functional.json), so a builder a project or a library adds is a pack
// entry, not a branch here.
//
// It reads one class on its own, as the Java worker recorded it
// (`routeFunction`). A method a mount annotation marks (`@Bean`) is served where
// its routes say; a route-building method of the same class that another calls
// with no argument is read under its caller's prefix; any other one is
// `unmounted`, because the code that mounts it is elsewhere and decides its
// prefix. Which Java method a handler reference names, and where an unmounted
// route is served, are the Java bridge's questions (src/adapters/java/
// functional_routes.mjs).

import { UNKNOWN, UNREAD } from '../java_routes_read.mjs';
import { pathOfRoute, readBody, settle } from '../java_routes_eval.mjs';

/**
 * The return types the Java worker records a method's body for, by simple name.
 * Mirrored from adapters/java/JavaFacts.java (`ROUTE_FUNCTION_TYPES`); a test
 * holds the two equal. A rule may only read a type in this list: another one
 * needs the worker to record it first.
 */
export const WORKER_ROUTE_TYPES = Object.freeze(['RouterFunction']);

const NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const WRITTEN = /^[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*)*$/;
const VERB = /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/;
const CALL_DOES = Object.freeze(['start', 'route', 'nest', 'combine', 'keep', 'build', 'resources']);
const PREDICATE_DOES = Object.freeze(['match', 'and']);
const CALL_ROLES = Object.freeze(['path', 'predicate', 'handler', 'routes', 'operation', 'any']);
const PREDICATE_ROLES = Object.freeze(['path', 'method', 'predicate', 'any']);
const PARAM_KEYS = Object.freeze(['returnTypes', 'wrappers', 'mountAnnotations', 'calls', 'predicates', 'methods', 'operationId']);
const unknownKeys = (obj, allowed) => Object.keys(obj).filter((k) => !allowed.includes(k));
const isNameList = (v, re = NAME) => Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === 'string' && re.test(s));

/** One form, `"path handler"`, as its roles; `""` is a call with no argument. */
const rolesOf = (form) => (form === '' ? [] : form.split(' '));

/** Everything wrong with one entry of `calls` or `predicates`. */
function entryErrors(entry, where, { does, roles }) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [`${where} must be an object`];
  const errors = unknownKeys(entry, ['names', 'on', 'does', 'verb', 'forms']).map((k) => `${where} has an unknown key "${k}"`);
  if (!isNameList(entry.names)) errors.push(`${where}.names must list method names`);
  if (entry.on !== undefined && !isNameList(entry.on)) errors.push(`${where}.on must list the classes a static call is made on`);
  if (entry.does !== undefined && !does.includes(entry.does)) errors.push(`${where}.does must be one of ${does.join(', ')}`);
  if (entry.verb !== undefined && (typeof entry.verb !== 'string' || !VERB.test(entry.verb))) errors.push(`${where}.verb must be an HTTP verb`);
  if (entry.forms === '*') return errors;
  if (!Array.isArray(entry.forms) || entry.forms.length === 0) return [...errors, `${where}.forms must list the argument roles of each form, or be "*"`];
  for (const form of entry.forms) {
    const bad = typeof form !== 'string' ? [String(form)] : rolesOf(form).filter((r) => !roles.includes(r));
    if (bad.length > 0) errors.push(`${where}.forms has ${JSON.stringify(form)}: each role must be one of ${roles.join(', ')}`);
  }
  return errors;
}

function validateParams(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return ['params must be an object'];
  const errors = unknownKeys(params, PARAM_KEYS).map((k) => `params has an unknown key "${k}"`);
  if (!isNameList(params.returnTypes)) errors.push('params.returnTypes must list the return types whose methods are read');
  else for (const t of params.returnTypes.filter((x) => !WORKER_ROUTE_TYPES.includes(x))) errors.push(`params.returnTypes has ${t}, which the Java worker does not record (it records ${WORKER_ROUTE_TYPES.join(', ')})`);
  if (params.wrappers !== undefined && !isNameList(params.wrappers)) errors.push('params.wrappers must list the types that hand routes over (Supplier), when given');
  if (!isNameList(params.mountAnnotations)) errors.push('params.mountAnnotations must list the annotations that make a method\'s routes served where they say');
  if (!isNameList(params.operationId ?? ['x'])) errors.push('params.operationId must list the calls that name an operation');
  const methods = params.methods ?? {};
  if (typeof methods !== 'object' || Array.isArray(methods) || Object.entries(methods).some(([k, v]) => !WRITTEN.test(k) || !VERB.test(v))) {
    errors.push('params.methods must map an HTTP method as the source writes it (HttpMethod.GET) to a verb');
  }
  if (!Array.isArray(params.calls) || params.calls.length === 0) errors.push('params.calls must list the calls this rule reads');
  else params.calls.forEach((e, i) => errors.push(...entryErrors(e, `params.calls[${i}]`, { does: CALL_DOES, roles: CALL_ROLES }), ...(e?.does === undefined ? [`params.calls[${i}].does must say what the call does`] : [])));
  if (!Array.isArray(params.predicates)) errors.push('params.predicates must list the request predicates this rule reads');
  else params.predicates.forEach((e, i) => errors.push(...entryErrors(e, `params.predicates[${i}]`, { does: PREDICATE_DOES, roles: PREDICATE_ROLES })));
  return errors;
}

const EXPECT_ROUTE_KEYS = Object.freeze(['function', 'mount', 'verb', 'path', 'handler', 'operationId']);

function expectErrors(expect) {
  if (!Array.isArray(expect)) return ['an example needs "expect", the routes and the unread parts its source gives (empty for none)'];
  return expect.flatMap((e, i) => {
    if (e && typeof e.function === 'string' && typeof e.unread === 'string' && Object.keys(e).length === 2) {
      return e.unread in UNREAD || e.unread === 'resources' ? [] : [`expect[${i}].unread must be one of ${Object.keys(UNREAD).join(', ')}, resources`];
    }
    const ok = e && ['function', 'mount', 'verb', 'path', 'handler'].every((k) => typeof e[k] === 'string')
      && ['bean', 'unmounted'].includes(e.mount) && unknownKeys(e, EXPECT_ROUTE_KEYS).length === 0;
    return ok ? [] : [`expect[${i}] must be {function, mount, verb, path, handler} with an optional operationId, or {function, unread}`];
  });
}

function validateExample(example) {
  if (!example || typeof example !== 'object' || Array.isArray(example)) return ['an example must be an object'];
  const errors = unknownKeys(example, ['source', 'expect', 'why']).map((k) => `an example has an unknown key "${k}"`);
  if (typeof example.source !== 'string' || example.source.trim() === '') errors.push('an example needs a Java "source"');
  return [...errors, ...expectErrors(example.expect)];
}

const setOf = (list) => new Set(list ?? []);
const compileEntries = (list, rule, defaultDoes) => (list ?? []).map((e) => Object.freeze({
  names: setOf(e.names), on: e.on ? setOf(e.on) : null, does: e.does ?? defaultDoes, verb: e.verb ?? null,
  forms: e.forms === '*' ? '*' : e.forms.map(rolesOf), rule,
}));

/** The rule's vocabulary, ready for the reader. */
function compile(rule) {
  const p = rule.params;
  return Object.freeze({
    rule: rule.id,
    returnTypes: setOf(p.returnTypes),
    wrappers: setOf(p.wrappers),
    mount: setOf(p.mountAnnotations),
    calls: compileEntries(p.calls, rule.id, null),
    predicates: compileEntries(p.predicates, rule.id, 'match'),
    methods: new Map(Object.entries(p.methods ?? {})),
    operationId: setOf(p.operationId),
  });
}

/** The keys two entries collide on: the same name, called on the same class (or on a value), with the same arguments. */
const entryKeys = (table, e) => [...e.names].flatMap((n) => (e.on ? [...e.on] : ['.']).flatMap((o) => (e.forms === '*' ? ['*'] : e.forms.map((f) => f.join(' ')))
  .map((f) => `${n}|${table}|${o}|${f}`)));

/**
 * One vocabulary from every rule of the kind, in the registry's order. Two
 * rules that read one call two ways are a conflict and stop the run: which one
 * wins is never decided by the order the packs load in.
 */
export function vocabularyOf(compiledRules) {
  const seen = new Map();
  for (const v of compiledRules) {
    for (const [table, e] of [...v.calls.map((c) => ['call', c]), ...v.predicates.map((p) => ['predicate', p])]) {
      for (const key of entryKeys(table, e)) {
        const said = `${e.does}|${e.verb}`;
        const prev = seen.get(key);
        if (prev && prev.said !== said) throw new Error(`the rules ${prev.rule} and ${e.rule} read ${key.split('|')[0]} two ways`);
        seen.set(key, { said, rule: e.rule });
      }
    }
  }
  const union = (k) => new Set(compiledRules.flatMap((v) => [...v[k]]));
  return {
    rules: compiledRules.map((v) => v.rule), returnTypes: union('returnTypes'), wrappers: union('wrappers'), mount: union('mount'), operationId: union('operationId'),
    calls: compiledRules.flatMap((v) => v.calls), predicates: compiledRules.flatMap((v) => v.predicates),
    methods: new Map(compiledRules.flatMap((v) => [...v.methods])),
  };
}

const simpleOf = (fqn) => fqn.slice(fqn.lastIndexOf('.') + 1);

/** The route-building methods of one class, each read; a method another one calls is read there instead. */
function readClass(recs, vocab) {
  const helpers = new Map();
  for (const r of recs) if (!helpers.has(r.method) || r.paramCount === 0) helpers.set(r.method, r);
  const inlined = new Set();
  const read = recs.map((rec) => {
    const ctx = { vocab, constants: rec.constants ?? {}, ownSimple: simpleOf(rec.owner), helpers, inlined, notes: [], stack: [rec.method] };
    const { value } = readBody(rec, ctx);
    if (value.t === 'unknown') ctx.notes.push({ code: value.code, text: value.text, line: rec.line ?? null });
    return { rec, routes: settle(value.routes), notes: ctx.notes };
  });
  return read.map(({ rec, routes, notes }) => {
    // A bean that returns something holding routes (a Supplier of them) is not a router function the framework registers.
    const bean = !rec.returnWrapper && (rec.annotations ?? []).some((a) => vocab.mount.has(a));
    const mount = bean ? 'bean' : inlined.has(rec.method) && rec.paramCount === 0 ? 'helper' : 'unmounted';
    return { function: `${rec.owner}#${rec.method}`, owner: rec.owner, method: rec.method, file: rec.file ?? null, line: rec.line ?? null, mount, routes, notes };
  }).filter((m) => m.mount !== 'helper');
}

/**
 * Every route-building method among `javaFacts`, read with the vocabulary of
 * `rules`, one class at a time. Each comes back with its mount, its routes
 * (paths relative to that mount) and what could not be read.
 *
 * @param {object[]} javaFacts  assembled worker records
 * @param {{compiled:object}[]} rules  the `java.route-function` rules
 */
export function readRouteFunctions(javaFacts, rules) {
  if (rules.length === 0) return [];
  const vocab = vocabularyOf(rules.map((r) => r.compiled));
  const byOwner = new Map();
  for (const r of javaFacts) {
    if (!r || r.kind !== 'routeFunction' || !vocab.returnTypes.has(r.returnType)) continue;
    if (r.returnWrapper && !vocab.wrappers.has(r.returnWrapper)) continue;
    const key = `${r.owner} ${r.file ?? ''}`;
    if (!byOwner.has(key)) byOwner.set(key, []);
    byOwner.get(key).push(r);
  }
  return [...byOwner.values()].flatMap((recs) => readClass(recs, vocab));
}

/** A handler as an example writes it: `this::list`, `handler::show`, or `handler.show()` for a lambda that calls it. */
export function handlerWords(h) {
  if (!h) return UNKNOWN;
  const recv = h.via === 'this' ? 'this' : h.via === 'super' ? 'super' : h.name;
  return h.lambda ? `${recv}.${h.method}()` : `${recv}::${h.method}`;
}

/** What one example's methods give, in the example's own words. */
function exampleWords(read) {
  const out = [];
  for (const m of read) {
    const fn = `${simpleOf(m.owner)}#${m.method}`;
    for (const r of m.routes) {
      out.push({ function: fn, mount: m.mount, verb: r.verb, path: pathOfRoute(r), handler: handlerWords(r.handler), ...(r.operationId ? { operationId: r.operationId } : {}) });
      for (const u of r.unread) out.push({ function: fn, unread: u.code });
    }
    for (const n of m.notes) out.push({ function: fn, unread: n.code });
  }
  const seen = new Set();
  return out.filter((e) => { const k = JSON.stringify(e); return seen.has(k) ? false : (seen.add(k), true); });
}

const canonical = (list) => JSON.stringify([...list].map((e) => JSON.stringify(e, Object.keys(e).sort())).sort());

/**
 * Every example of every rule of this kind, parsed by the real Java worker once
 * (`env.javaFacts(files)`), each read with its own rule alone. Without a JDK the
 * examples are NOT RUN, which is reported as such and is not a pass.
 */
function runExamples(entries, env) {
  const files = entries.flatMap((entry) => entry.rule.examples.map((ex, i) => ({ name: `${entry.id}/example${i}.java`, text: ex.source })));
  const facts = env && typeof env.javaFacts === 'function' ? env.javaFacts(files) : null;
  if (facts === null) return { notRun: 'no Java worker: a JDK is needed to parse the examples (see docs/setup/java-lane.md)' };
  return {
    results: new Map(entries.map((entry) => [entry.id, entry.rule.examples.map((ex, i) => {
      const own = facts.filter((r) => r.file === `${entry.id}/example${i}.java`);
      const got = exampleWords(readRouteFunctions(own, [entry]));
      return { example: ex, passed: canonical(got) === canonical(ex.expect), got };
    })])),
  };
}

export const javaRouteFunction = Object.freeze({
  name: 'java.route-function',
  lane: 'java',
  stage: 'java-bridge',
  // A route whose path and handler the source states is what the framework serves.
  gradeCap: 'EXACT',
  validateParams,
  validateExample,
  compile,
  runExamples,
});
