// typeorm_options.mjs — which naming strategy, table prefix and schema a TypeORM application runs with, read from the options its source writes.
//
// TypeORM takes all three from the DataSource options: `namingStrategy`, an
// instance (DefaultNamingStrategy when the key is not there), `entityPrefix`,
// put before every table name, and `schema`, the schema of every entity that
// names none of its own (EntityMetadata.build). The options are found where
// the rule pack says an application writes them: `TypeOrmModule.forRoot({...})`,
// the object a `forRootAsync` factory or options class returns, `new
// DataSource({...})`.
//
// Each fact is read or it is not, at every place. Options held in a variable,
// spread from another object, read from ormconfig or the environment
// (`forRoot()` with no argument), or built in a function body this engine does
// not read, may set any of them: then that fact is not known, the names that
// rest on it are graded HEURISTIC, and every place that could not be read is
// said. So are two places that disagree. A fact is known when every place was
// read and all agree, or when the profile declares it (`tsBackend.typeorm`).
import { externalOf, isOneOf, isPlainObject, refsErrors, unknownKeysAt } from './ts_names.mjs';

const OPTION_KEYS = Object.freeze(['calls', 'constructors', 'namingKey', 'prefixKey', 'schemaKey', 'factoryKey', 'classKeys', 'classMethod', 'handsOptionsTo']);
/** The three facts, and what the profile's `tsBackend.typeorm` block calls each. */
export const FACTS = Object.freeze(['namingStrategy', 'entityPrefix', 'schema']);

export function optionsErrors(o) {
  if (!isPlainObject(o)) return ['params.options must be an object'];
  const errors = unknownKeysAt(o, OPTION_KEYS, 'params.options');
  errors.push(...refsErrors(o.calls, 'params.options.calls', ['member']), ...refsErrors(o.constructors, 'params.options.constructors'));
  for (const k of ['namingKey', 'prefixKey', 'schemaKey', 'factoryKey', 'classMethod', 'handsOptionsTo']) if (typeof o[k] !== 'string' || o[k] === '') errors.push(`params.options.${k} must be a key as the source writes it`);
  if (!Array.isArray(o.classKeys) || !o.classKeys.every((k) => typeof k === 'string' && k !== '')) errors.push('params.options.classKeys must list keys as the source writes them');
  return errors;
}

/** The call a site names: `TypeOrmModule.forRoot` through its export, or a function the package exports. */
function callSiteRef(project, file, callee, calls) {
  const dot = callee.lastIndexOf('.');
  const ext = externalOf(project, file, dot < 0 ? callee : callee.slice(0, dot));
  if (!ext) return null;
  const member = dot < 0 ? undefined : callee.slice(dot + 1);
  return calls.find((c) => c.module === ext.module && c.export === ext.name && c.member === member) ?? null;
}

/** Every `{k:'call'}` value inside a decorator's arguments: `imports: [TypeOrmModule.forRoot({...})]` is written there. */
function callsInValue(v, out) {
  if (!v || typeof v !== 'object') return out;
  if (v.k === 'call' && typeof v.callee === 'string') out.push(v);
  for (const x of v.k === 'arr' ? v.v : v.k === 'obj' ? Object.values(v.v) : v.k === 'call' ? v.args : []) callsInValue(x, out);
  return out;
}

/**
 * The function a `forRootAsync` hands the options it built to (its
 * `dataSourceFactory`): a DataSource made there from its parameter runs with
 * those options, so it is not another place they are written.
 */
function handedTo(value, opts, file) {
  const fn = value && value.k === 'obj' ? value.v[opts.handsOptionsTo] : null;
  return fn && fn.k === 'fn' && fn.params[0] ? { file, from: fn.line, to: fn.endLine, param: fn.params[0] } : null;
}

/** Every place the source writes TypeORM's options: `{file, line, how, value, async}`. */
function optionSites(project, opts) {
  const sites = [];
  const handed = [];
  const add = (file, line, callee, args) => {
    const ref = callSiteRef(project, file, callee, opts.calls);
    if (!ref) return;
    sites.push({ file, line, how: callee, value: args[0] ?? { k: 'none' }, async: ref.member === 'forRootAsync' });
    const h = ref.member === 'forRootAsync' ? handedTo(args[0], opts, file) : null;
    if (h) handed.push(h);
  };
  for (const c of project.calls) add(c.file, c.line, c.callee, c.args);
  for (const [file, f] of project.files) {
    for (const cls of f.classes.values()) {
      for (const d of cls.decorators) for (const v of d.args.flatMap((a) => callsInValue(a, []))) add(file, cls.line, v.callee, v.args);
    }
  }
  const passedOn = (n) => handed.some((h) => h.file === n.file && n.line >= h.from && n.line <= h.to && n.args[0]?.k === 'id' && n.args[0].v === h.param);
  for (const n of project.news ?? []) {
    if (isOneOf(externalOf(project, n.file, n.callee), opts.constructors) && !passedOn(n)) sites.push({ file: n.file, line: n.line, how: `new ${n.callee}`, value: n.args[0] ?? { k: 'none' }, async: false });
  }
  return sites;
}

/** The option objects a `forRootAsync` argument builds: a factory's returned value, or what the options class's method returns. */
function asyncOptionValues(project, file, value, opts) {
  if (!value || value.k !== 'obj' || value.spread || value.computed) return { unread: 'its argument is not an object written out' };
  const factory = value.v[opts.factoryKey];
  if (factory) return factory.k === 'fn' && factory.returns ? { values: [factory.returns] } : { unread: `its ${opts.factoryKey} does not return an object this engine reads` };
  const classKey = opts.classKeys.find((k) => value.v[k]);
  const named = classKey ? value.v[classKey] : null;
  const cls = named && named.k === 'id' ? project.classOf(file, named.v) : null;
  const method = cls ? project.lineage(cls).map((c) => c.methods.get(opts.classMethod)).find(Boolean) : null;
  if (!method || !method.returns || method.returns.length === 0) return { unread: `its options come from ${classKey ? `${classKey} ${named?.v ?? 'a value'}` : 'a key this engine does not read'}, whose ${opts.classMethod} this engine does not read` };
  return { values: method.returns };
}

/** The strategy one options object names: `{value}` (null for none, which is the default) or `{unread}`. */
function strategyOf(project, file, v, opts, strategies) {
  const ns = v.v[opts.namingKey];
  if (!ns || ns.k === 'undefined') return { value: null };
  if (ns.k !== 'new') return { unread: `its ${opts.namingKey} is not a class written out where the options are` };
  const ext = externalOf(project, file, ns.callee);
  const hit = strategies.find((x) => ext && x.module === ext.module && x.export === ext.name);
  return hit ? { value: hit.name } : { unread: `its ${opts.namingKey} is ${ns.callee}, a class this engine does not model` };
}

/** A string option: `{value}` ('' when the key is not there) or `{unread}`. */
function literalOf(v, key) {
  const x = v.v[key];
  if (!x || x.k === 'undefined') return { value: '' };
  return x.k === 'str' ? { value: x.v } : { unread: `its ${key} is not a literal` };
}

const allUnread = (why) => Object.fromEntries(FACTS.map((f) => [f, { unread: why }]));

/** What one options object says of each fact. */
function readOptionsObject(project, file, value, opts, strategies) {
  if (!value || value.k === 'none') return allUnread('it takes no options in the source, so they come from ormconfig or the environment at run time');
  if (value.k !== 'obj') return allUnread('its options are held in a value this engine does not read');
  if (value.spread || value.computed) return allUnread('its options spread another object, which may set any of them');
  return { namingStrategy: strategyOf(project, file, value, opts, strategies), entityPrefix: literalOf(value, opts.prefixKey), schema: literalOf(value, opts.schemaKey) };
}

/** What a place says of each fact: an options object, or every object a `forRootAsync` factory or options class may return. */
function readSite(project, site, opts, strategies) {
  if (!site.async) return readOptionsObject(project, site.file, site.value, opts, strategies);
  const built = asyncOptionValues(project, site.file, site.value, opts);
  if (built.unread) return allUnread(built.unread);
  if (built.values.some((v) => v.k === 'none')) return allUnread(`its ${opts.classMethod} may end without returning options`);
  const read = built.values.map((v) => readOptionsObject(project, site.file, v, opts, strategies));
  return Object.fromEntries(FACTS.map((f) => {
    const values = [...new Set(read.map((r) => r[f].value))];
    return [f, read.find((r) => r[f].unread)?.[f] ?? (values.length > 1 ? { unread: `it may return different ${f} values` } : read[0][f])];
  }));
}

/** One fact across every place: `{value, known, why}`. */
function factOf(sites, fact) {
  const where = (s) => `${s.how} at ${s.file}:${s.line}`;
  if (sites.length === 0) return { value: null, known: false, why: 'no TypeORM options were found in the source (TypeOrmModule.forRoot, forRootAsync, new DataSource)' };
  const unread = sites.filter((s) => s.read[fact].unread);
  if (unread.length > 0) return { value: null, known: false, why: unread.map((s) => `${where(s)}: ${s.read[fact].unread}`).join('; ') };
  const values = [...new Set(sites.map((s) => s.read[fact].value))];
  if (values.length > 1) return { value: null, known: false, why: `the options disagree on ${fact}: ${sites.map((s) => `${where(s)} says ${JSON.stringify(s.read[fact].value)}`).join('; ')}` };
  return { value: values[0], known: true, why: `every options object says so (${sites.map(where).join('; ')})` };
}

/**
 * What the application runs with, and how each part is known: `{strategy,
 * known, reason}` for the naming strategy (the default's when nothing names
 * one), `{prefix, prefixKnown, prefixWhy}` and `{schema, schemaKnown,
 * schemaWhy}`, with every place read in `sites`.
 */
export function readNaming(project, opts, naming) {
  const sites = optionSites(project, opts).map((s) => ({ ...s, read: readSite(project, s, opts, naming.strategies) }));
  const [ns, prefix, schema] = FACTS.map((f) => factOf(sites, f));
  const said = sites.map((s) => ({ file: s.file, line: s.line, how: s.how, ...Object.fromEntries(FACTS.map((f) => [f, s.read[f].unread ? { unread: s.read[f].unread } : s.read[f].value])) }));
  return {
    strategy: naming.strategies.find((x) => x.name === ns.value) ?? naming.defaultStrategy, known: ns.known, reason: ns.known ? `${ns.value ?? naming.defaultStrategy.name}: ${ns.why}` : ns.why,
    prefix: prefix.value ?? '', prefixKnown: prefix.known, prefixWhy: prefix.why, schema: schema.value ?? '', schemaKnown: schema.known, schemaWhy: schema.why, sites: said,
  };
}

/** The strategy a profile names: '' is none named, which is the default; null when it names one the pack does not. */
const declaredStrategy = (naming, name) => (name === '' ? naming.defaultStrategy : naming.strategies.find((x) => x.name === name) ?? null);

/**
 * The facts the profile declares (`tsBackend.typeorm`: null is not declared,
 * '' is declared none), used instead of what the options say: known, and said
 * as the profile's. The options are still read for the rest, and a declaration
 * that differs from what they say is said too (`differs`).
 */
export function declaredNaming(project, opts, naming, declared) {
  const read = readNaming(project, opts, naming);
  const out = { ...read, declared: [], differs: [] };
  const ns = declared.namingStrategy == null ? null : declaredStrategy(naming, declared.namingStrategy);
  if (ns) {
    if (read.known && read.strategy.name !== ns.name) out.differs.push(`namingStrategy ${ns.name}, where the options name ${read.strategy.name}`);
    Object.assign(out, { strategy: ns, known: true, reason: `${ns.name}: the profile declares it (tsBackend.typeorm.namingStrategy)` });
    out.declared.push('namingStrategy');
  }
  for (const [fact, key] of [['entityPrefix', 'prefix'], ['schema', 'schema']]) {
    const v = declared[fact];
    if (v == null) continue;
    if (read[`${key}Known`] && read[key] !== v) out.differs.push(`${fact} ${JSON.stringify(v)}, where the options say ${JSON.stringify(read[key])}`);
    Object.assign(out, { [key]: v, [`${key}Known`]: true, [`${key}Why`]: `the profile declares it (tsBackend.typeorm.${fact})` });
    out.declared.push(fact);
  }
  return out;
}
