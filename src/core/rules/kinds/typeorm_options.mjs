// typeorm_options.mjs — which naming strategy and table prefix a TypeORM application runs with, read from the options its source writes.
//
// TypeORM takes both from the DataSource options: `namingStrategy`, an
// instance (DefaultNamingStrategy when the key is not there), and
// `entityPrefix`. The options are found where the rule pack says an
// application writes them: `TypeOrmModule.forRoot({...})`, the object a
// `forRootAsync` factory or options class returns, `new DataSource({...})`.
//
// Each place is read or it is not. Options held in a variable, spread from
// another object, read from ormconfig or the environment (`forRoot()` with no
// argument), or built in a function body this engine does not read, may name
// any strategy: then the names derived under the default are ASSUMED, and every
// place that could not be read is said. So are two places that name different
// strategies. Only when every place was read and all agree is the strategy
// known.

import { externalOf, isOneOf, isPlainObject, refsErrors, unknownKeysAt } from './ts_names.mjs';

const OPTION_KEYS = Object.freeze(['calls', 'constructors', 'namingKey', 'prefixKey', 'factoryKey', 'classKeys', 'classMethod', 'handsOptionsTo']);

export function optionsErrors(o) {
  if (!isPlainObject(o)) return ['params.options must be an object'];
  const errors = unknownKeysAt(o, OPTION_KEYS, 'params.options');
  errors.push(...refsErrors(o.calls, 'params.options.calls', ['member']), ...refsErrors(o.constructors, 'params.options.constructors'));
  for (const k of ['namingKey', 'prefixKey', 'factoryKey', 'classMethod', 'handsOptionsTo']) if (typeof o[k] !== 'string' || o[k] === '') errors.push(`params.options.${k} must be a key as the source writes it`);
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

/** What one options object says: `{strategy}` (a strategy's name, or `unknown:` and why) and `{prefix}` (a string, or null when not known). */
function readOptionsObject(project, file, value, opts, strategies) {
  if (!value || value.k === 'none') return { unread: 'it takes no options in the source, so they come from ormconfig or the environment at run time' };
  if (value.k !== 'obj') return { unread: 'its options are held in a value this engine does not read' };
  if (value.spread || value.computed) return { unread: 'its options spread another object, which may set the naming strategy' };
  const ns = value.v[opts.namingKey];
  let strategy = null;
  if (!ns) strategy = null;
  else if (ns.k === 'new') {
    const ext = externalOf(project, file, ns.callee);
    strategy = strategies.find((s) => ext && s.module === ext.module && s.export === ext.name)?.name;
    if (!strategy) return { unread: `its ${opts.namingKey} is ${ns.callee}, a class this engine does not model` };
  } else return { unread: `its ${opts.namingKey} is not a class written out where the options are` };
  const p = value.v[opts.prefixKey];
  if (p && p.k !== 'str') return { unread: `its ${opts.prefixKey} is not a literal` };
  return { strategy, prefix: p ? p.v : '' };
}

function readSite(project, site, opts, strategies) {
  if (!site.async) return readOptionsObject(project, site.file, site.value, opts, strategies);
  const built = asyncOptionValues(project, site.file, site.value, opts);
  if (built.unread) return built;
  const read = built.values.map((v) => readOptionsObject(project, site.file, v, opts, strategies));
  return read.find((r) => r.unread) ?? read[0];
}

/**
 * The strategy and prefix the application runs with, and how that is known:
 * `{strategy, known, prefix, sites, reason}`. `strategy` is the default's when
 * nothing names one; `known` is false when any place could not be read, when
 * two disagree, or when no place was found at all.
 */
export function readNaming(project, opts, naming) {
  const sites = optionSites(project, opts).map((s) => ({ ...s, ...readSite(project, s, opts, naming.strategies) }));
  const where = (s) => `${s.how} at ${s.file}:${s.line}`;
  const said = sites.map((s) => ({ file: s.file, line: s.line, how: s.how, ...(s.unread ? { unread: s.unread } : { strategy: s.strategy ?? naming.defaultStrategy.name, prefix: s.prefix }) }));
  const assumed = (reason) => ({ strategy: naming.defaultStrategy, known: false, prefix: null, sites: said, reason });
  if (sites.length === 0) return assumed('no TypeORM options were found in the source (TypeOrmModule.forRoot, forRootAsync, new DataSource)');
  const unread = sites.filter((s) => s.unread);
  if (unread.length > 0) return assumed(unread.map((s) => `${where(s)}: ${s.unread}`).join('; '));
  const names = [...new Set(said.map((s) => s.strategy))];
  const prefixes = [...new Set(said.map((s) => s.prefix))];
  if (names.length > 1 || prefixes.length > 1) return assumed(`the options disagree: ${said.map((s) => `${where(s)} names ${s.strategy}${s.prefix ? ` with prefix ${s.prefix}` : ''}`).join('; ')}`);
  return { strategy: naming.strategies.find((s) => s.name === names[0]), known: true, prefix: prefixes[0], sites: said, reason: `every options object names ${names[0]} (${said.map(where).join('; ')})` };
}

/**
 * The strategy the profile declares (`tsBackend.typeormNamingStrategy`), which
 * is used instead of what the options name: known, and said as the profile's.
 * The options are still read, for the table prefix where they are written, and
 * so a declaration that differs from a strategy they name is said.
 */
export function declaredNaming(project, opts, naming, declared) {
  const strategy = naming.strategies.find((s) => s.name === declared);
  const read = readNaming(project, opts, naming);
  if (!strategy) return { ...read, reason: `${read.reason}; the profile declares ${declared}, which is not a strategy the typeorm pack names` };
  const differs = read.known && read.strategy.name !== strategy.name ? read.strategy.name : null;
  return {
    strategy, known: true, declared: true, prefix: read.known ? read.prefix : '', sites: read.sites, differs,
    reason: `the profile declares tsBackend.typeormNamingStrategy ${declared}${differs ? `, which differs from ${differs} the options name` : ''}${read.known ? '' : `; an entityPrefix is taken as none, since the options are not all read (${read.reason})`}`,
  };
}
