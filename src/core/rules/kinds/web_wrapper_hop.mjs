// web_wrapper_hop.mjs — the `web.wrapper-hop` rule kind: what a framework's own
// wrapper step does to the request it hands on, where the step's code alone
// does not settle it.
//
// The web lane walks a wrapper chain hop by hop and counts a step as settled
// only where the source shows it hands the URL, the method and the base URL on
// as the caller gave them (default-deny, adapters/web/lib/uses.mjs). A
// framework's client class may pass the request through a local that its hooks
// assign again, which that reading rightly cannot settle, while the
// framework's own source says what each part of the step does. This kind knows
// HOW such a step is recognized, by the shape of the class it is a method of
// (the client its field is built by, the methods it declares, the method that
// is the step and which parameters carry the request and its options), and
// HOW a statement of what it does to each key is read. The packs say WHICH
// framework, and what it does (src/core/rules/packs/). A step no rule names is
// read as its code reads, and stays unsettled.
//
// What a rule says a key becomes, one word each:
//   keep     handed on as the caller gave it
//   set      the step or its hooks write their own value: not settled
//   prefix   the URL is handed on behind a prefix the request options named in
//            `by` decide (the instance's options, and the call's own at
//            `hop.options`): which prefix is not read, and a call whose own
//            options may name one of those keys is not settled
//   append   the value the request carries under `from` is appended to the
//            URL's path when it is text (`when: "text"`): a call that may hand
//            text there is not settled
//   query    a query string is added: the path is what it was
//   change   the step changes a key the route does not depend on (a body, a
//            header): said, and nothing the walk follows
// Which of these the lane acts on, and how, is the web lane's question
// (src/adapters/web/named_hop.mjs); this module only reads the statement and
// finds the steps it names.

const NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const DOES = Object.freeze(['keep', 'set', 'prefix', 'append', 'query', 'change']);
const URL_DOES = Object.freeze(['keep', 'set', 'prefix', 'append', 'query']);
const OTHER_DOES = Object.freeze(['keep', 'set', 'change']);
const PARAM_KEYS = Object.freeze(['client', 'class', 'hop', 'keys', 'framework']);
const unknownKeys = (obj, allowed) => Object.keys(obj).filter((k) => !allowed.includes(k));
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (s) => typeof s === 'string' && s.trim() !== '';
const isNameList = (v) => Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === 'string' && NAME.test(s));
const isIndex = (v) => Number.isInteger(v) && v >= 0 && v < 8;

/** What is wrong with the client, the class's shape and the step. */
function shapeErrors(p) {
  const errors = [];
  const c = p.client;
  if (!isObject(c) || unknownKeys(c, ['module', 'factory']).length > 0 || !isText(c.module) || !NAME.test(c.factory ?? '')) {
    errors.push('params.client must name the client library\'s module and the factory its field is built by ({ "module", "factory" })');
  }
  if (!isObject(p.class) || unknownKeys(p.class, ['methods']).length > 0 || !isNameList(p.class.methods)) {
    errors.push('params.class.methods must list the methods the class declares, the shape it is known by');
  }
  const h = p.hop;
  if (!isObject(h) || unknownKeys(h, ['method', 'config', 'options']).length > 0 || !NAME.test(h.method ?? '')
    || !isIndex(h.config) || (h.options !== undefined && (!isIndex(h.options) || h.options === h.config))) {
    errors.push('params.hop must name the method that is the step, the parameter the request comes in at (config) and, apart from it, the one its options come in at (options)');
  } else if (isObject(p.class) && Array.isArray(p.class.methods) && !p.class.methods.includes(h.method)) {
    errors.push('params.class.methods must include the step\'s own method');
  }
  return errors;
}

/** What is wrong with one effect of one key. */
function effectErrors(e, key, allowed, hop) {
  const where = `params.keys.${key}`;
  if (!isObject(e)) return [`${where} must list effects, each an object`];
  const errors = unknownKeys(e, ['does', 'by', 'from', 'when']).map((k) => `${where} has an effect with an unknown key "${k}"`);
  if (!allowed.includes(e.does)) return [...errors, `${where} does must be one of ${allowed.join(', ')} (${DOES.join(', ')} are the words of this kind)`];
  if (e.by !== undefined && !isNameList(e.by)) errors.push(`${where} by must list the option keys that decide it`);
  if (e.does === 'prefix' && (e.by === undefined || !isObject(hop) || hop.options === undefined)) {
    errors.push(`${where} prefix must list the option keys that decide it (by), and params.hop must name the options parameter`);
  }
  if (e.does === 'append' && (!NAME.test(e.from ?? '') || e.when !== 'text')) errors.push(`${where} append must name the request key appended (from) and when ("text")`);
  if (e.does !== 'append' && (e.from !== undefined || e.when !== undefined)) errors.push(`${where} only append takes from and when`);
  return errors;
}

/** What is wrong with the statement of what the step does to each key. */
function keysErrors(keys, hop) {
  if (!isObject(keys)) return ['params.keys must say what the step does to each key'];
  const errors = [];
  if (!keys.url) errors.push('params.keys.url must say what the step does to the URL');
  if (!keys.method) errors.push('params.keys.method must say what the step does to the method');
  for (const [key, effects] of Object.entries(keys)) {
    if (!NAME.test(key) || !Array.isArray(effects) || effects.length === 0) { errors.push(`params.keys.${key} must list one effect or more`); continue; }
    const allowed = key === 'url' ? URL_DOES : OTHER_DOES;
    errors.push(...effects.flatMap((e) => effectErrors(e, key, allowed, hop)));
    const words = effects.map((e) => e.does);
    if ((words.includes('keep') || words.includes('set')) && effects.length > 1) errors.push(`params.keys.${key} keep and set each stand alone`);
  }
  return errors;
}

function validateParams(params) {
  if (!isObject(params)) return ['params must be an object'];
  const errors = unknownKeys(params, PARAM_KEYS).map((k) => `params has an unknown key "${k}"`);
  errors.push(...shapeErrors(params), ...keysErrors(params.keys, params.hop));
  const f = params.framework;
  if (!isObject(f) || unknownKeys(f, ['name', 'declares', 'source']).length > 0 || !isText(f.name) || !isText(f.declares) || !isText(f.source)) {
    errors.push('params.framework must say which framework (name), what the rule relies on its step doing (framework.declares) and where anyone can check it (source)');
  }
  return errors;
}

/** What is wrong with one example's expectation. */
function expectErrors(expect) {
  if (!isObject(expect) || (expect.hops === undefined && expect.calls === undefined)) return ['an example expects the steps the rule names (hops), what calls through them send (calls), or both'];
  const errors = unknownKeys(expect, ['hops', 'calls']).map((k) => `an example's expect has an unknown key "${k}"`);
  if (expect.hops !== undefined && !(Array.isArray(expect.hops) && expect.hops.every(isText))) errors.push('expect.hops must list step keys (file#Class.method)');
  if (expect.calls !== undefined && !isObject(expect.calls)) errors.push('expect.calls must map a function name to what its call sends');
  for (const [fn, c] of Object.entries(isObject(expect.calls) ? expect.calls : {})) {
    if (!isObject(c) || unknownKeys(c, ['to', 'unsettled', 'prefix']).length > 0 || !isText(c.to) || !(c.unsettled === null || isText(c.unsettled))) {
      errors.push(`expect.calls.${fn} must say the route it reaches (to, "GET /path"), why it is not settled or null (unsettled), and may say its prefix's source (prefix)`);
    }
  }
  return errors;
}

function validateExample(example) {
  if (!isObject(example)) return ['an example must be an object'];
  const errors = unknownKeys(example, ['files', 'routes', 'expect', 'why']).map((k) => `an example has an unknown key "${k}"`);
  if (!Array.isArray(example.files) || example.files.length === 0 || !example.files.every((f) => isObject(f) && isText(f.name) && typeof f.text === 'string')) {
    errors.push('an example needs its source files ({ "name", "text" })');
  }
  if (example.routes !== undefined && !(Array.isArray(example.routes) && example.routes.every((r) => /^[A-Z]+ \/\S*$/.test(r)))) {
    errors.push('an example\'s routes are "VERB /path"');
  }
  return [...errors, ...expectErrors(example.expect)];
}

/** The statement, ready for the lane: what the step does to the URL, and a word for any other key. */
function compile(rule) {
  const p = rule.params;
  const url = p.keys.url;
  const effect = (does) => url.find((e) => e.does === does) ?? null;
  const words = new Map(Object.entries(p.keys).filter(([k]) => k !== 'url').map(([k, effects]) => [k, effects[0].does]));
  return Object.freeze({
    rule: rule.id,
    client: Object.freeze({ ...p.client }),
    methods: Object.freeze([...p.class.methods]),
    hop: Object.freeze({ method: p.hop.method, config: p.hop.config, options: p.hop.options ?? null }),
    url: Object.freeze({
      set: effect('set') !== null,
      prefix: effect('prefix') ? Object.freeze([...effect('prefix').by]) : null,
      append: Object.freeze(url.filter((e) => e.does === 'append').map((e) => e.from)),
    }),
    // A key the rule does not state is one the step may write: never kept.
    keyDoes: (key) => words.get(key) ?? 'set',
  });
}

/** Whether a field's first value is built by the client's factory, imported from its module. */
function builtBy(init, client) {
  const c = init && init.shape === 'call' ? init.callee : null;
  const b = init ? init.binding : null;
  return !!(c && b && Array.isArray(c.path) && c.path.length === 1 && c.path[0] === client.factory
    && b.kind === 'import' && b.source === client.module);
}

/** The records of these facts the shape is read from: classes, the fields they set, and functions by key. */
function shapesOf(records) {
  const classes = [];
  const fields = new Set();
  const functions = new Map();
  for (const r of records) {
    if (!r || typeof r.file !== 'string') continue;
    if (r.kind === 'class' && Array.isArray(r.methods)) classes.push(r);
    else if (r.kind === 'assign' && typeof r.class === 'string') fields.add(r);
    else if (r.kind === 'function' && typeof r.name === 'string') functions.set(`${r.file}#${r.name}`, r);
  }
  return { classes, fields: [...fields], functions };
}

/**
 * THE STEPS THESE RULES NAME in one set of web facts: `file#Class.method` for
 * each class whose shape a rule states (every method it lists, a field built by
 * the client's factory, the step's method taking the parameters it names),
 * with the rule. Two rules that name one step are a conflict and stop the run:
 * which one it is is never decided by the order the packs load in.
 *
 * @param {object[]} records  web facts (adapters/web/webfacts.mjs)
 * @param {{id:string, compiled:object}[]} entries  registry entries of this kind
 * @returns {Map<string,{rule:string, hop:object}>}
 */
export function namedHopsOf(records, entries) {
  const { classes, fields, functions } = shapesOf(records);
  const out = new Map();
  for (const entry of entries) {
    const c = entry.compiled;
    const needs = Math.max(c.hop.config, c.hop.options ?? 0) + 1;
    for (const cls of classes) {
      if (!c.methods.every((m) => cls.methods.includes(m))) continue;
      if (!fields.some((a) => a.file === cls.file && a.class === cls.name && builtBy(a.init, c.client))) continue;
      const key = `${cls.file}#${cls.name}.${c.hop.method}`;
      const fn = functions.get(key);
      if (!fn || !Number.isInteger(fn.params) || fn.params < needs) continue;
      const had = out.get(key);
      if (had && had.rule !== entry.id) {
        throw new Error(`rules ${had.rule} and ${entry.id} both name the wrapper step ${key}: which one it is is not decided by the order the packs load in`);
      }
      out.set(key, { rule: entry.id, hop: c });
    }
  }
  return out;
}

/** What one example's calls send, as its expectation says it: the route, why it is not settled, and the prefix's source. */
function callsOf(edges, wanted) {
  const out = {};
  for (const [fn, want] of Object.entries(wanted)) {
    const e = edges.find((x) => x.type === 'CALLS_HTTP' && x.from.endsWith(`#${fn}`));
    if (!e) { out[fn] = null; continue; }
    const got = { to: e.to.replace(/^endpoint:/, ''), unsettled: e.evidence.sink.unsettled?.why ?? null };
    if (want && want.prefix !== undefined) got.prefix = e.evidence.prefix?.from ?? null;
    out[fn] = got;
  }
  return out;
}

const canonical = (v) => JSON.stringify(v, (k, x) => (isObject(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

/**
 * The examples, read by the real web worker (`env.webFacts`) and walked by the
 * web lane with this rule alone (`env.webCalls`), since what the rule says is
 * what a call through the step it names sends.
 */
function runExamples(entries, env) {
  if (!env || typeof env.webFacts !== 'function' || typeof env.webCalls !== 'function') return { notRun: 'no web worker was handed in' };
  return {
    results: new Map(entries.map((entry) => [entry.id, entry.rule.examples.map((ex) => {
      const records = env.webFacts(ex.files);
      const got = {};
      if (ex.expect.hops !== undefined) got.hops = [...namedHopsOf(records, [entry]).keys()];
      if (ex.expect.calls !== undefined) got.calls = callsOf(env.webCalls(records, ex.routes ?? [], [entry]), ex.expect.calls);
      return { example: ex, passed: canonical(got) === canonical(ex.expect), got };
    })])),
  };
}

export const webWrapperHop = Object.freeze({
  name: 'web.wrapper-hop',
  lane: 'web',
  stage: 'web-bridge',
  // It draws no edge: the lane grades a call through the step as it grades any
  // wrapper, and a step the rule settles is no more than SOUND_SET.
  gradeCap: null,
  validateParams,
  validateExample,
  compile,
  runExamples,
});
