// jpa_entity_manager_factory.mjs — the `jpa.entity-manager-factory` rule kind: whether a project builds its own EntityManagerFactory, how, and whether it names a naming strategy in code.
//
// Spring Boot puts its naming defaults into the factory IT builds, and backs off
// when the project defines one (JpaBaseConfiguration: @ConditionalOnMissingBean
// on LocalContainerEntityManagerFactoryBean and EntityManagerFactory). A factory
// the project builds by hand then runs Hibernate's own defaults
// (MetadataBuilderImpl: PhysicalNamingStrategyStandardImpl and
// ImplicitNamingStrategyJpaCompliantImpl). One built from the builder Spring Boot
// hands out gets Boot's naming from 3.4 on (JpaBaseConfiguration.buildJpaProperties)
// and only `spring.jpa.properties` before it.
//
// This kind knows HOW that shows in the source, positively: a `new` of a type
// the rule lists, a @Bean method that returns one (built from the builder when
// it takes one as a parameter), a Spring XML bean of one; and a property key the
// rule lists, put into a map by a class that declares @Bean methods or set on a
// factory bean in XML, with the strategy class its value names where the value
// states one. The rule pack says WHICH types, keys and classes
// (src/core/rules/packs/jpa.json). A name the file does not place is not a
// factory: a type from a jar the tree does not import is missed, never guessed.

import { JPA_NAMING_STRATEGIES } from '../../profile.mjs';
import { javaNames, meaningOf } from '../java_names.mjs';
import { attributesOf, looksLikeSpringBeansXml, springBeansOf } from '../../springconfig.mjs';

/** The implicit naming rules the JPA bridge applies: Spring Boot's (SpringImplicitNamingStrategy) and Hibernate's own (ImplicitNamingStrategyJpaCompliantImpl). */
export const IMPLICIT_STRATEGIES = Object.freeze(['spring', 'jpa-compliant']);
const DIMENSIONS = Object.freeze({ physical: JPA_NAMING_STRATEGIES, implicit: IMPLICIT_STRATEGIES });

const unknownKeys = (obj, allowed) => Object.keys(obj).filter((k) => !allowed.includes(k));
const isText = (v) => typeof v === 'string' && v.trim() !== '';
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const QUALIFIED = /^(?:[a-z_$][A-Za-z0-9_$]*\.)+[A-Za-z_$][A-Za-z0-9_$]*$/;
/** A constant's full name: its type's full name, then the constant. */
const CONSTANT = /^(?:[a-z_$][A-Za-z0-9_$]*\.)+[A-Z][A-Za-z0-9_$]*\.[A-Za-z_$][A-Za-z0-9_$]*$/;
const simpleOf = (fqn) => fqn.slice(fqn.lastIndexOf('.') + 1);
const packageOf = (fqn) => fqn.slice(0, fqn.lastIndexOf('.'));

/** What is wrong with one list of `{type, source, ...}` entries; `more` checks the rest of each. */
function listErrors(list, name, allowed, more = () => []) {
  if (!Array.isArray(list) || list.length === 0) return [`params.${name} must be a non-empty list`];
  return list.flatMap((e, i) => {
    if (!isObj(e)) return [`params.${name}[${i}] must be an object`];
    const errors = unknownKeys(e, allowed).map((k) => `params.${name}[${i}] has an unknown key "${k}"`);
    if (!isText(e.source)) errors.push(`params.${name}[${i}].source must say where it is declared`);
    return [...errors, ...more(e, `params.${name}[${i}]`)];
  });
}

const typeError = (e, at) => (typeof e.type === 'string' && QUALIFIED.test(e.type) ? [] : [`${at}.type must be a type's full name`]);
const dimensionError = (e, at) => (Object.hasOwn(DIMENSIONS, e.dimension) ? [] : [`${at}.dimension must be physical or implicit`]);

function propertyErrors(e, at) {
  const errors = [...dimensionError(e, at)];
  if (!isText(e.key)) errors.push(`${at}.key must be the property key as Hibernate reads it`);
  if (!Array.isArray(e.constants) || !e.constants.every((c) => typeof c === 'string' && CONSTANT.test(c))) errors.push(`${at}.constants must list the full names of the constants that hold the key`);
  return errors;
}

function strategyErrors(e, at) {
  const errors = [...typeError(e, at), ...dimensionError(e, at)];
  if (Object.hasOwn(DIMENSIONS, e.dimension) && !DIMENSIONS[e.dimension].includes(e.strategy)) errors.push(`${at}.strategy must be one of ${DIMENSIONS[e.dimension].join(', ')}`);
  return errors;
}

const setterErrors = (e, at) => [...dimensionError(e, at), ...(isText(e.name) ? [] : [`${at}.name must be the bean property's name`])];

/** What is wrong with a rule's params, as sentences; empty when nothing is. */
function validateParams(params) {
  if (!isObj(params)) return ['params must be an object'];
  return [
    ...unknownKeys(params, ['factoryTypes', 'builderTypes', 'namingProperties', 'namingSetters', 'strategyClasses']).map((k) => `params has an unknown key "${k}"`),
    ...listErrors(params.factoryTypes, 'factoryTypes', ['type', 'source'], typeError),
    ...listErrors(params.builderTypes, 'builderTypes', ['type', 'source'], typeError),
    ...listErrors(params.namingProperties, 'namingProperties', ['key', 'dimension', 'constants', 'source'], propertyErrors),
    ...listErrors(params.namingSetters, 'namingSetters', ['name', 'dimension', 'source'], setterErrors),
    ...listErrors(params.strategyClasses, 'strategyClasses', ['type', 'dimension', 'strategy', 'source'], strategyErrors),
  ];
}

/** What is wrong with one example; empty when nothing is. */
function validateExample(example) {
  if (!isObj(example)) return ['an example must be an object'];
  const errors = unknownKeys(example, ['source', 'xml', 'expect', 'why']).map((k) => `an example has an unknown key "${k}"`);
  if (!isText(example.source) && !isText(example.xml)) errors.push('an example needs a Java "source", a Spring XML "xml", or both');
  if (example.source !== undefined && !isText(example.source)) errors.push('an example\'s "source" must be Java text');
  if (example.xml !== undefined && !isText(example.xml)) errors.push('an example\'s "xml" must be a Spring bean XML document');
  if (!Array.isArray(example.expect) || !example.expect.every(isText)) errors.push('an example needs "expect", the sites it finds as "<what> <how> <name>:<line>" (empty for none)');
  return errors;
}

/**
 * The listed type a name written in a file means, or null: what the file makes
 * of the name, or the one listed type of that name a package it imports whole
 * holds. `place` is anything with the file and its package.
 */
function listedMeaning(place, written, listed, names) {
  if (typeof written !== 'string' || written === '') return null;
  const m = meaningOf(place, { simple: simpleOf(written), written }, names);
  if (m?.fqn) return listed.has(m.fqn) ? m.fqn : null;
  const hits = (m?.packages ?? []).map((p) => `${p}.${simpleOf(written)}`).filter((q) => listed.has(q));
  return hits.length === 1 ? hits[0] : null;
}

/** Every `new` of a listed factory or builder type: a factory the project builds by hand. */
function constructedSites(facts, ctx) {
  return facts.filter((r) => r?.kind === 'constructions').flatMap((r) => (r.names ?? []).flatMap((written, i) => {
    const type = listedMeaning(r, written, ctx.constructed, ctx.names);
    return type ? [{ how: 'new', type, file: r.file, line: r.lines?.[i] ?? null }] : [];
  }));
}

/**
 * Every @Bean method that returns a listed factory type. One that takes Spring
 * Boot's builder as a parameter and constructs no factory itself is built from
 * the builder; any other is built by hand (a `new` in it is said as the `new`).
 */
function beanSites(facts, ctx) {
  const out = { handBuilt: [], builderMade: [] };
  for (const r of facts.filter((x) => x?.kind === 'beanMethod')) {
    const place = ctx.types.get(r.owner) ?? { file: r.file, package: packageOf(r.owner) };
    const type = listedMeaning(place, r.returns, ctx.factories, ctx.names);
    if (!type) continue;
    const site = { how: 'bean', type, method: `${r.owner}#${r.name}`, file: r.file, line: r.line ?? null };
    const builds = (r.constructs ?? []).some((w) => listedMeaning(place, w, ctx.constructed, ctx.names));
    const builder = (r.params ?? []).map((w) => listedMeaning(place, w, ctx.builders, ctx.names)).find(Boolean);
    if (builds) continue;
    if (builder) out.builderMade.push({ ...site, builder });
    else out.handBuilt.push(site);
  }
  return out;
}

/** The listed naming property a key written in a file names: its text, a listed constant, or a constant's own name a static import may bring in. */
function propertyOf(place, key, form, ctx) {
  if (form === 'literal') return ctx.properties.find((p) => p.key === key) ?? null;
  if (typeof key !== 'string') return null;
  const dot = key.lastIndexOf('.');
  if (dot < 0) return ctx.properties.find((p) => p.constants.some((c) => simpleOf(c) === key)) ?? null;
  const qualifier = key.slice(0, dot);
  const owner = meaningOf(place, { simple: simpleOf(qualifier), written: qualifier }, ctx.names);
  const full = owner?.fqn ? `${owner.fqn}.${key.slice(dot + 1)}` : null;
  return ctx.properties.find((p) => p.constants.includes(full)) ?? null;
}

/** The class a value states, as its file means it: a class name written as text, `X.class`, `new X()` or `X.INSTANCE`; null for anything else. */
function strategyClassOf(place, value, form, ctx) {
  if (typeof value !== 'string') return null;
  if (form === 'literal') return QUALIFIED.test(value.trim()) ? value.trim() : null;
  const written = form === 'name' ? (value.endsWith('.INSTANCE') ? value.slice(0, -'.INSTANCE'.length) : null) : value;
  if (!written) return null;
  return listedMeaning(place, written, ctx.strategyTypes, ctx.names)
    ?? meaningOf(place, { simple: simpleOf(written), written }, ctx.names)?.fqn ?? null;
}

/** One naming setting, with the strategy its value names when the rule lists that class for the setting's dimension. */
function namingSite(prop, className, at, ctx) {
  const known = className ? ctx.strategyClasses.find((s) => s.type === className && s.dimension === prop.dimension) : null;
  return { dimension: prop.dimension, key: prop.key ?? prop.name, className, strategy: known ? known.strategy : null, ...at };
}

/** Every naming property a class with @Bean methods puts into a map. */
function namingInJava(facts, ctx) {
  return facts.filter((r) => r?.kind === 'propertyKeys').flatMap((r) => {
    const place = ctx.types.get(r.owner) ?? { file: r.file, package: packageOf(r.owner) };
    return (r.keys ?? []).flatMap((k) => {
      const prop = propertyOf(place, k.key, k.keyForm, ctx);
      if (!prop) return [];
      const at = { via: 'property', written: k.key, file: r.file, line: k.line ?? null };
      return [namingSite(prop, strategyClassOf(place, k.value, k.valueForm, ctx), at, ctx)];
    });
  });
}

/** The factories a Spring XML declares, and the naming settings each is given there. */
function xmlSites(xmlFactories, ctx) {
  const handBuilt = [];
  const naming = [];
  for (const b of xmlFactories ?? []) {
    if (!ctx.factories.has(b.className) && !ctx.constructed.has(b.className)) continue;
    handBuilt.push({ how: 'xml', type: b.className, file: b.file, line: b.line ?? null });
    for (const k of b.keys ?? []) {
      const prop = k.via === 'property' ? ctx.setters.find((s) => s.name === k.key) : ctx.properties.find((p) => p.key === k.key);
      if (!prop) continue;
      const className = typeof k.value === 'string' && QUALIFIED.test(k.value.trim()) ? k.value.trim() : null;
      naming.push(namingSite(prop, className, { via: 'xml', written: k.key, file: b.file, line: k.line ?? null }, ctx));
    }
  }
  return { handBuilt, naming };
}

/** What one rule reads with: its lists as sets, and the tree's types and names. */
function contextOf(javaFacts, params) {
  const set = (list) => new Set(list.map((e) => e.type));
  const factories = set(params.factoryTypes);
  const builders = set(params.builderTypes);
  return {
    factories, builders, constructed: new Set([...factories, ...builders]),
    properties: params.namingProperties, setters: params.namingSetters,
    strategyClasses: params.strategyClasses, strategyTypes: set(params.strategyClasses),
    types: new Map(javaFacts.filter((r) => r?.kind === 'type').map((t) => [t.fqn, t])),
    names: javaNames(javaFacts),
  };
}

const bySite = (a, b) => String(a.file).localeCompare(String(b.file)) || (a.line ?? 0) - (b.line ?? 0);

/** Sites sorted by place, each place once. */
function onePerPlace(sites) {
  const seen = new Set();
  return [...sites].sort(bySite).filter((s) => {
    const k = `${s.file}:${s.line}`;
    return seen.has(k) ? false : (seen.add(k), true);
  });
}

/**
 * What one rule reads from a tree: the factories it builds by hand (`new`, a
 * @Bean with no builder, an XML bean), the ones it builds from Spring Boot's
 * builder, and the naming settings it states in code or XML. `xmlFactories` is
 * what `xmlFactoriesIn` read from the tree's Spring XML.
 */
export function readFactories(javaFacts, rule, xmlFactories = []) {
  const facts = Array.isArray(javaFacts) ? javaFacts : [];
  const ctx = contextOf(facts, rule.params);
  const beans = beanSites(facts, ctx);
  const xml = xmlSites(xmlFactories, ctx);
  return {
    rule: rule.id,
    handBuilt: onePerPlace([...constructedSites(facts, ctx), ...beans.handBuilt, ...xml.handBuilt]),
    builderMade: onePerPlace(beans.builderMade),
    naming: [...namingInJava(facts, ctx), ...xml.naming].sort(bySite),
  };
}

/** A line inside a bean's body: the body's first line plus the newlines before the offset. */
const lineIn = (bean, at) => bean.bodyLine + (bean.body.slice(0, at).match(/\n/g)?.length ?? 0);

/** `<prop key="K">V</prop>` and `<entry key="K" value="V"/>` (or `<value>V</value>`) in a bean's body, for the keys listed. */
function xmlPropertyKeys(bean, keys) {
  const out = [];
  for (const m of bean.body.matchAll(/<(?:\w+:)?prop\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?prop\s*>/g)) {
    const key = attributesOf(m[1]).get('key');
    if (keys.has(key)) out.push({ via: 'prop', key, value: m[2].trim(), line: lineIn(bean, m.index) });
  }
  for (const m of bean.body.matchAll(/<(?:\w+:)?entry\b([^>]*?)(\/?)>/g)) {
    const attrs = attributesOf(m[1]);
    const key = attrs.get('key');
    if (!keys.has(key)) continue;
    const inner = m[2] === '/' ? null : /^\s*<(?:\w+:)?value\s*>([\s\S]*?)<\/(?:\w+:)?value>/.exec(bean.body.slice(m.index + m[0].length));
    out.push({ via: 'entry', key, value: attrs.get('value') ?? (inner ? inner[1].trim() : null), line: lineIn(bean, m.index) });
  }
  return out;
}

/** `<property name="physicalNamingStrategy" value="…">` or with an inner `<bean class="…">`, for the bean properties listed. */
function xmlSetterKeys(bean, setters) {
  const out = [];
  for (const m of bean.body.matchAll(/<(?:\w+:)?property\b([^>]*?)(\/?)>/g)) {
    const attrs = attributesOf(m[1]);
    const key = attrs.get('name');
    if (!setters.has(key)) continue;
    const inner = m[2] === '/' ? null : /^\s*<(?:\w+:)?bean\b([^>]*?)\/?>/.exec(bean.body.slice(m.index + m[0].length));
    out.push({ via: 'property', key, value: attrs.get('value') ?? (inner ? attributesOf(inner[1]).get('class') ?? null : null), line: lineIn(bean, m.index) });
  }
  return out;
}

/**
 * THE FACTORY BEANS A SPRING XML DECLARES, of the types the rule lists, with
 * the naming settings each one's body gives it. Discovery reads the tree's
 * Spring XML once (src/core/discover.mjs) and hands these to the JPA bridge.
 * @param {{path:string, text:string}[]} files
 * @returns {{className:string, file:string, line:number, keys:object[]}[]}
 */
export function xmlFactoriesIn(files, rule) {
  const listed = new Set([...rule.params.factoryTypes, ...rule.params.builderTypes].map((t) => t.type));
  const keys = new Set(rule.params.namingProperties.map((p) => p.key));
  const setters = new Set(rule.params.namingSetters.map((s) => s.name));
  const out = [];
  for (const f of files ?? []) {
    if (!f || typeof f.text !== 'string' || !looksLikeSpringBeansXml(f.text)) continue;
    for (const b of springBeansOf(f.text).filter((x) => listed.has(x.className))) {
      const found = [...xmlPropertyKeys(b, keys), ...xmlSetterKeys(b, setters)].sort((x, y) => x.line - y.line);
      out.push({ className: b.className, file: f.path, line: b.line, keys: found });
    }
  }
  return out;
}

/** The rule, ready to read a tree: a function from the Java worker's records and the XML factories to what `readFactories` gives. */
function compile(rule) {
  return (javaFacts, xmlFactories = []) => readFactories(javaFacts, rule, xmlFactories);
}

/** What a reading found, one line per site, the way an example's `expect` says it. */
function sitesSaid(read) {
  return [
    ...read.handBuilt.map((s) => `hand-built ${s.how} ${s.how === 'bean' ? s.method : s.type}:${s.line}`),
    ...read.builderMade.map((s) => `builder-made bean ${s.method}:${s.line}`),
    ...read.naming.map((s) => `naming ${s.dimension} ${s.strategy ?? '?'}:${s.line}`),
  ].sort();
}

/**
 * Every example's Java through the real Java worker once (`env.javaFacts`),
 * each example a tree of its own, and its XML through `xmlFactoriesIn`.
 * Without a JDK the examples are NOT RUN, never passed.
 */
function runExamples(entries, env) {
  const javaOf = (entry, ex, i) => (ex.source ? [{ name: `${entry.id}/example${i}.java`, text: ex.source }] : []);
  const files = entries.flatMap((entry) => entry.rule.examples.flatMap((ex, i) => javaOf(entry, ex, i)));
  const facts = env && typeof env.javaFacts === 'function' ? env.javaFacts(files) : null;
  if (facts === null) return { notRun: 'no Java worker: a JDK is needed to parse the examples (see docs/setup/java-lane.md)' };
  return {
    results: new Map(entries.map((entry) => [entry.id, entry.rule.examples.map((ex, i) => {
      const own = facts.filter((r) => r.file === `${entry.id}/example${i}.java`);
      const xml = ex.xml ? xmlFactoriesIn([{ path: `${entry.id}/example${i}.xml`, text: ex.xml }], entry.rule) : [];
      const got = sitesSaid(readFactories(own, entry.rule, xml));
      return { example: ex, passed: JSON.stringify(got) === JSON.stringify([...ex.expect].sort()), got };
    })])),
  };
}

export const jpaEntityManagerFactory = Object.freeze({
  name: 'jpa.entity-manager-factory',
  lane: 'java',
  // Read by the JPA bridge before it names anything: which naming the factory runs with.
  stage: 'jpa-bridge',
  // It only classifies how a factory is built; the names carry their own grade.
  gradeCap: null,
  validateParams,
  validateExample,
  compile,
  runExamples,
});
