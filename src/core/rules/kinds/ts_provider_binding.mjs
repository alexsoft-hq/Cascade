// ts_provider_binding.mjs — the `ts.provider-binding` rule kind: what a module binds to a type, read from its providers.
//
// `@Module({ providers: [{ provide: UserRepository, useClass: UsersRelationalRepository }] })`
// makes Nest inject a UsersRelationalRepository wherever a constructor asks for
// a UserRepository, and `providers: [UsersService]` binds a class to itself.
// This kind knows HOW a providers list is read: which entry binds which token
// to which class, which binding it does not read (a factory, a value, another
// token) and which entry it cannot read at all (a spread, a computed key, a
// call). The rule packs say WHICH names mean what
// (src/core/rules/packs/nestjs.json).
//
// It reads one module on its own. Which modules the application loads, and
// whether a binding narrows a call's candidate set, is the bridge's question
// (src/adapters/ts/nest_providers.mjs). It draws no edge itself, so a rule of
// this kind carries no grade.

const NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const KEYS = Object.freeze(['module', 'list', 'token', 'useClass', 'notRead', 'injectByToken', 'harmless', 'consumed']);
const unknownKeys = (obj, allowed) => Object.keys(obj).filter((k) => !allowed.includes(k));
const isName = (v) => typeof v === 'string' && NAME.test(v);

/** Whether a param is a list of names; `least` of them at the least, and nothing at all when it may be left out. */
const namesListed = (v, least = 0, optional = false) => (optional && v === undefined) || (Array.isArray(v) && v.length >= least && v.every(isName));

const LISTS = Object.freeze([
  ['notRead', 1, false, 'params.notRead must list the keys of a binding this kind does not read (useFactory, useValue, ...)'],
  // A parameter decorator either fills the parameter by the token it names, or changes nothing about what
  // fills it; any other is not known, and the bridge settles nothing by it.
  ['injectByToken', 1, false, 'params.injectByToken must list the parameter decorators that fill a parameter by the token they name (Inject)'],
  ['harmless', 0, false, 'params.harmless must list the parameter decorators that leave what fills a parameter as it is'],
  ['consumed', 0, true, 'params.consumed must list the keys of a package module\'s options whose names the package reads and binds to nothing else'],
]);

function validateParams(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return ['params must be an object'];
  const errors = unknownKeys(params, KEYS).map((k) => `params has an unknown key "${k}"`);
  for (const k of ['module', 'list', 'token', 'useClass']) {
    if (!isName(params[k])) errors.push(`params.${k} must be a name as the source writes it`);
  }
  for (const [k, least, optional, said] of LISTS) if (!namesListed(params[k], least, optional)) errors.push(said);
  return errors;
}

function validateExpect(e, i) {
  const shapes = [['module', 'token', 'useClass'], ['module', 'token', 'notRead'], ['module', 'unread']];
  const fits = e && typeof e === 'object' && shapes.some((keys) => unknownKeys(e, keys).length === 0 && Object.keys(e).length === keys.length);
  const typed = fits && Object.entries(e).every(([k, v]) => (k === 'unread' ? v === true : typeof v === 'string'));
  return typed ? [] : [`expect[${i}] must be {module, token, useClass}, {module, token, notRead} or {module, unread: true}`];
}

function validateExample(example) {
  if (!example || typeof example !== 'object' || Array.isArray(example)) return ['an example must be an object'];
  const errors = unknownKeys(example, ['source', 'expect', 'why']).map((k) => `an example has an unknown key "${k}"`);
  if (typeof example.source !== 'string' || example.source.trim() === '') errors.push('an example needs a TypeScript "source"');
  if (!Array.isArray(example.expect)) return [...errors, 'an example needs "expect", the bindings its source declares (empty for none)'];
  example.expect.forEach((e, i) => errors.push(...validateExpect(e, i)));
  return errors;
}

/**
 * One providers entry, as the value the worker summarized: a name alone binds
 * the class it names to itself (the bridge checks it is a class); `{provide,
 * useClass}` binds the token to that class; a key the rule does not read
 * leaves the binding unread; a token that is not a name binds no type; anything
 * else (a spread, a computed key, a call) cannot be read.
 */
function entryOf(params, v) {
  if (v.k === 'id') return { token: v.v, useClass: v.v };
  if (v.k !== 'obj' || v.spread || v.computed) return { unread: true };
  const token = v.v[params.token];
  if (!token) return { unread: true };
  if (token.k !== 'id') return { token: null };
  const use = v.v[params.useClass];
  if (use) return use.k === 'id' ? { token: token.v, useClass: use.v } : { token: token.v, notRead: params.useClass };
  const other = params.notRead.find((k) => Object.hasOwn(v.v, k));
  return other ? { token: token.v, notRead: other } : { unread: true };
}

/**
 * The rule, ready to read a module class (its decorators by their package
 * names): `providersOf(cls)` is null for a class that is not a module, else
 * whether its options are read whole, whether its list spreads another, and
 * each entry as `entryOf` reads it.
 */
/** How a providers list is read out of a module's options object: whether it spreads another, and each entry. */
function listReader(params) {
  // A list held in a variable, or one that spreads another, may bind anything.
  return (opts) => {
    const list = opts?.v[params.list];
    const items = list && list.k === 'arr' ? list.v : [];
    return { spread: Boolean(list && (list.k !== 'arr' || list.spread)), entries: items.map((v) => entryOf(params, v)) };
  };
}

function compile(rule) {
  const { params } = rule;
  const listIn = listReader(params);
  const providersOf = (cls) => {
    const d = cls.decorators.find((x) => x.name === params.module);
    if (!d) return null;
    const arg = d.args[0];
    const opts = arg && arg.k === 'obj' ? arg : null;
    return { readable: !arg || (Boolean(opts) && !opts.spread && !opts.computed), ...listIn(opts) };
  };
  // The same list in an object a static method returns: a dynamic module (`X.forRoot()`).
  const providersIn = (value) => (value && value.k === 'obj'
    ? { readable: !value.spread && !value.computed, ...listIn(value) } : { readable: false, spread: false, entries: [] });
  // What a constructor parameter's decorator does to what fills it, by the name its package gives it.
  const parameterDecorator = (name) => (params.injectByToken.includes(name) ? 'token' : params.harmless.includes(name) ? 'harmless' : 'unknown');
  return { providersOf, providersIn, parameterDecorator, consumed: params.consumed ?? [], rule: rule.id };
}

/** What one example's modules bind, in the example's own words. */
function bindingsOfExample(compiled, records) {
  const classes = records.filter((r) => r.kind === 'class');
  return classes.flatMap((cls) => {
    const decl = compiled.providersOf(cls);
    if (!decl) return [];
    const whole = decl.readable && !decl.spread ? [] : [{ module: cls.name, unread: true }];
    return [...whole, ...decl.entries.filter((e) => e.unread || e.token).map((e) => (e.unread ? { module: cls.name, unread: true }
      : e.useClass ? { module: cls.name, token: e.token, useClass: e.useClass } : { module: cls.name, token: e.token, notRead: e.notRead }))];
  });
}

const canonical = (list) => JSON.stringify([...list].map((e) => JSON.stringify(e, Object.keys(e).sort())).sort());

function runExamples(entries, env) {
  if (!env || typeof env.tsFacts !== 'function') return { notRun: 'no TypeScript reader was handed in' };
  const results = new Map(entries.map((entry) => [entry.id, entry.rule.examples.map((ex, i) => {
    const got = bindingsOfExample(entry.compiled, env.tsFacts(`${entry.id}/example${i}.ts`, ex.source));
    return { example: ex, passed: canonical(got) === canonical(ex.expect), got };
  })]));
  return { results };
}

export const tsProviderBinding = Object.freeze({
  name: 'ts.provider-binding',
  lane: 'ts',
  stage: 'ts-facts',
  // A binding narrows a set; it draws no edge of its own to grade.
  gradeCap: null,
  validateParams,
  validateExample,
  compile,
  runExamples,
});
