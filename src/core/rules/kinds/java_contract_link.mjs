// java_contract_link.mjs — the `java.contract-link` rule kind: which operation of an OpenAPI document a Java method handles, when the interface that says so is generated at build time.
//
// A contract-first Spring project keeps its API in an OpenAPI document. The
// build runs a code generator over it, which writes one interface per group of
// operations (`OwnersApi`), one method per operation named by its operationId,
// each carrying the mapping annotation; the project's own controller
// `implements OwnersApi`. The generated interface is not in the source tree, so
// the Java lane sees a controller with no mapping, and the document's routes
// stand with nothing under them.
//
// This kind knows HOW such a pairing is read: a concrete class whose own
// implements clause names an interface the project does not declare, and a
// method of that class whose name is an operation's operationId, where the
// interface's name is the one the generator gives that operation's group. The
// rule packs say WHICH generator's naming, which suffix, and where that naming
// is written down (src/core/rules/packs/openapi-generator.json).
//
// It is a guess, and graded as one: the interface that would state the pairing
// is not read, so all that joins the two is the generator's naming convention.
// An operationId the interface's name fits on two different routes (two
// documents, each with its own base path) is said and not linked, and so is a
// method named like an operationId whose operation the interface's name does
// not fit: neither is settled by picking one. Two documents that put the
// operationId on the same route name one route, and that is one link.
//
// What the rule reads of a name is exact: the method's name is the operationId
// as the document writes it. The generator rewrites some (a hyphen, a Java
// keyword) into another method name, and those are not matched: a missing link,
// never a guessed one.

import { nodeId } from '../../graph.mjs';
import { javaNames, meaningOf } from '../java_names.mjs';

/** Where the generator takes a group's name from: the operation's tags, or the first segment of its path. */
const NAMED_FROM = Object.freeze(['tag', 'path']);
const JAVA_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const REASONS = Object.freeze(['ambiguous', 'interface-name']);

const unknownKeys = (obj, allowed) => Object.keys(obj).filter((k) => !allowed.includes(k));
const isText = (v) => typeof v === 'string' && v.trim() !== '';
const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------------------
// How openapi-generator names an operation's interface. Each function follows
// the generator's own, named beside it, for the characters a name can hold.
// ---------------------------------------------------------------------------

/** DefaultCodegen.sanitizeName: brackets, parentheses, dots, colons, hyphens, bars, spaces and slashes to `_`, then every other non-word character dropped. */
function sanitizeName(name) {
  return String(name).replace(/\[\]/g, '').replace(/[[(]/g, '_').replace(/[\])]/g, '')
    .replace(/[.:\-| /\\]/g, '_').replace(/\W/g, '');
}

/** StringUtils.underscore, for a sanitized name: a word boundary inside a camel-cased name becomes `_`, and all of it lower case. */
function underscore(word) {
  return word.replace(/([A-Z]+)([A-Z][a-z][a-z]+)/g, '$1_$2').replace(/([a-z\d])([A-Z])/g, '$1_$2').toLowerCase();
}

/**
 * StringUtils.camelize, for a sanitized name: the first character upper case,
 * and each `_` taken out with the character after it upper-cased, one at a
 * time from the left as the generator's loop does.
 */
function camelize(word) {
  let w = word.length > 0 ? word[0].toUpperCase() + word.slice(1) : word;
  for (let m = /_(.)/.exec(w); m !== null; m = /_(.)/.exec(w)) {
    const up = m[1].toUpperCase();
    w = up === m[1] ? w.replace('_', '') : `${w.slice(0, m.index)}${up}${w.slice(m.index + 2)}`;
  }
  return w.replace(/_/g, '');
}

/** SpringCodegen.toApiName: the group's name, camelized, and the suffix; a group with no name is DefaultApi. */
function apiName(group, suffix) {
  return group.length === 0 ? 'DefaultApi' : `${camelize(sanitizeName(group))}${suffix}`;
}

/** AbstractJavaCodegen.sanitizeTag: a tag as a group name. An operation with no tag is in the tag "default" (DefaultGenerator). */
function tagGroup(tag) {
  const name = camelize(underscore(sanitizeName(tag)));
  return /^\d/.test(name) ? `Class${name}` : name;
}

/** SpringCodegen.addOperationToGroup without useTags: the first segment of the path as the document writes it. */
function pathGroup(resource) {
  let base = String(resource ?? '');
  if (base.startsWith('/')) base = base.slice(1);
  const pos = base.indexOf('/');
  if (pos > 0) base = base.slice(0, pos);
  return base === '' ? 'default' : base;
}

/** Every interface name the generator could give an operation, under the schemes a rule names. */
function interfaceNamesOf(op, from, suffix) {
  const names = new Set();
  if (from.includes('tag')) for (const tag of (op.tags.length > 0 ? op.tags : ['default'])) names.add(apiName(tagGroup(tag), suffix));
  if (from.includes('path')) names.add(apiName(pathGroup(op.resource), suffix));
  return names;
}

// ---------------------------------------------------------------------------
// The rule's shape
// ---------------------------------------------------------------------------

function interfaceNameErrors(n) {
  if (!isObject(n)) return ['params.interfaceName must be an object: {from, suffix}'];
  const errors = unknownKeys(n, ['from', 'suffix']).map((k) => `params.interfaceName has an unknown key "${k}"`);
  if (!Array.isArray(n.from) || n.from.length === 0 || n.from.some((f) => !NAMED_FROM.includes(f)) || new Set(n.from).size !== n.from.length) {
    errors.push(`params.interfaceName.from must list, once each, where a name is taken from: ${NAMED_FROM.join(', ')}`);
  }
  if (typeof n.suffix !== 'string' || !JAVA_NAME.test(n.suffix)) errors.push('params.interfaceName.suffix must be the part of a Java name the generator puts after the group\'s');
  return errors;
}

/** A rule that pairs by a generator's naming says which generator, what it relies on it doing, and where that is written. */
function generatorErrors(gen) {
  if (!isObject(gen)) return ['params.generator must say which generator names the interface, what the rule relies on it doing, and where that is written: {name, declares, source}'];
  const errors = unknownKeys(gen, ['name', 'declares', 'source']).map((k) => `params.generator has an unknown key "${k}"`);
  for (const k of ['name', 'declares', 'source']) if (!isText(gen[k])) errors.push(`params.generator.${k} must be text`);
  return errors;
}

function validateParams(params) {
  if (!isObject(params)) return ['params must be an object'];
  const errors = unknownKeys(params, ['interfaceName', 'generator']).map((k) => `params has an unknown key "${k}"`);
  return [...errors, ...interfaceNameErrors(params.interfaceName), ...generatorErrors(params.generator)];
}

function expectErrors(expect) {
  if (!Array.isArray(expect)) return ['an example needs "expect", the links its source and documents give (empty for none)'];
  return expect.flatMap((e, i) => {
    const link = isObject(e) && isText(e.handler) && isText(e.endpoint) && unknownKeys(e, ['handler', 'endpoint']).length === 0;
    const said = isObject(e) && isText(e.handler) && REASONS.includes(e.unlinked) && unknownKeys(e, ['handler', 'unlinked']).length === 0;
    return link || said ? [] : [`expect[${i}] must be {handler, endpoint} for a link or {handler, unlinked} with unlinked one of ${REASONS.join(', ')}`];
  });
}

function validateExample(example) {
  if (!isObject(example)) return ['an example must be an object'];
  const errors = unknownKeys(example, ['source', 'documents', 'expect', 'why']).map((k) => `an example has an unknown key "${k}"`);
  if (!isText(example.source)) errors.push('an example needs a Java "source"');
  if (!isObject(example.documents) || Object.keys(example.documents).length === 0 || Object.values(example.documents).some((d) => !isText(d))) {
    errors.push('an example needs "documents": each OpenAPI document by its path, as text');
  }
  return [...errors, ...expectErrors(example.expect)];
}

/** The rule, ready to read: what an operation's interface may be called, and what a link from it is graded. */
function compile(rule) {
  const { from, suffix } = rule.params.interfaceName;
  return {
    rule: rule.id, grade: rule.grade ?? 'HEURISTIC', suffix, generator: rule.params.generator.name,
    interfaceNames: (op) => interfaceNamesOf(op, from, suffix),
  };
}

// ---------------------------------------------------------------------------
// Reading a project
// ---------------------------------------------------------------------------

/**
 * Every operation of every document, each kept with the document it is in:
 * two documents that give one operationId are two operations here, never one
 * merged into the other.
 *
 * @param {object[]} documents  as the OpenAPI reader returns them (src/adapters/openapi_bridge.mjs)
 */
export function operationsOf(documents) {
  return (documents ?? []).flatMap((doc) => (doc.paths ?? []).filter((p) => p.operationId).map((p) => ({
    document: doc.path ?? '', method: p.method, path: p.path, resource: p.resource ?? p.path,
    operationId: p.operationId, tags: Array.isArray(p.tags) ? p.tags : [],
    endpoint: nodeId('endpoint', `${p.method} ${p.path}`),
  })));
}

/**
 * The interfaces a class names in its own implements clause that the project
 * does not declare: `{simple, fqn}`, fqn null when only the simple name is
 * known. An interface the project declares is the Java lane's to read.
 */
function outsideInterfaces(t, names) {
  const out = [];
  (t.implements ?? []).forEach((simple, i) => {
    const meaning = meaningOf(t, { simple, written: (t.implementsWritten ?? [])[i] ?? null }, names);
    if (meaning?.fqn) { if (!names.declared.has(meaning.fqn)) out.push({ simple, fqn: meaning.fqn }); return; }
    const inProject = (meaning?.packages ?? []).some((p) => names.declared.has(`${p}.${simple}`));
    if (!inProject) out.push({ simple, fqn: null });
  });
  return out;
}

/** The names of the methods a type declares itself, once each (the worker records `name/arity`). */
const methodNamesOf = (t) => [...new Set((t.declaredMethods ?? []).map((m) => String(m).split('/')[0]))];

const where = (list) => list.map((op) => ({ document: op.document, endpoint: op.endpoint }))
  .sort((a, b) => cmp(a.document, b.document) || cmp(a.endpoint, b.endpoint));

/**
 * What one rule concludes about one method of a class that implements one
 * interface outside the tree, given the operations of that name.
 *
 * The operations the interface's name fits must all be one route for a link.
 * Two documents that declare the same route under one operationId name one
 * endpoint, whichever of them the generator read, and the link names both.
 * Two that put it on different routes are said, not settled.
 */
function verdictOf(compiled, t, iface, method, ops) {
  const handler = `${t.fqn}#${method}`;
  const face = iface.fqn ?? iface.simple;
  const fit = ops.filter((op) => compiled.interfaceNames(op).has(iface.simple));
  const endpoints = [...new Set(fit.map((op) => op.endpoint))];
  if (endpoints.length === 1) {
    return { link: {
      rule: compiled.rule, grade: compiled.grade, handler, endpoint: endpoints[0], operationId: method,
      documents: [...new Set(fit.map((op) => op.document))].sort(), interface: face, generator: compiled.generator,
    } };
  }
  const reason = endpoints.length > 1 ? 'ambiguous' : 'interface-name';
  const names = reason === 'ambiguous' ? [] : [...new Set(ops.flatMap((op) => [...compiled.interfaceNames(op)]))].sort();
  return { unlinked: {
    rule: compiled.rule, handler, reason, operationId: method, interface: face,
    operations: where(reason === 'ambiguous' ? fit : ops), ...(names.length > 0 ? { names } : {}),
  } };
}

/**
 * One method against every interface of its class the rule reads. A method an
 * interface links is not also said to miss another interface's name: a class
 * implementing two generated interfaces has methods of both.
 */
function verdictsOfMethod(compiled, t, faces, method, ops) {
  const verdicts = faces.map((iface) => verdictOf(compiled, t, iface, method, ops));
  if (!verdicts.some((v) => v.link)) return verdicts;
  return verdicts.filter((v) => v.link || v.unlinked.reason === 'ambiguous');
}

/** Every verdict the rules give one class. */
function verdictsOfClass(t, names, byOperationId, rules) {
  const faces = outsideInterfaces(t, names);
  const out = [];
  for (const { compiled } of rules) {
    const own = faces.filter((f) => f.simple.endsWith(compiled.suffix));
    if (own.length === 0) continue;
    for (const method of methodNamesOf(t)) {
      const ops = byOperationId.get(method);
      if (ops) out.push(...verdictsOfMethod(compiled, t, own, method, ops));
    }
  }
  return out;
}

const rank = { EXACT: 4, SOUND_SET: 3, HEURISTIC: 2, RUNTIME_ONLY: 1, UNRESOLVED: 0 };

/**
 * The links every `java.contract-link` rule gives, and the methods it names
 * without linking them, over a whole project.
 *
 * A method can handle more than one route (a class implementing two generated
 * interfaces), so links add up. One link two rules both give is one link, as
 * sure as the surer rule.
 *
 * @param {object[]} javaFacts  the assembled Java worker records
 * @param {object[]} operations  from operationsOf
 * @param {{id:string, compiled:object}[]} rules
 * @returns {{links:object[], unlinked:object[]}} each sorted
 */
export function deriveContractLinks(javaFacts, operations, rules) {
  if (rules.length === 0 || operations.length === 0) return { links: [], unlinked: [] };
  const names = javaNames(javaFacts);
  const byOperationId = new Map();
  for (const op of operations) byOperationId.set(op.operationId, [...(byOperationId.get(op.operationId) ?? []), op]);
  const links = new Map();
  const unlinked = [];
  for (const t of javaFacts) {
    if (t?.kind !== 'type' || t.typeKind !== 'class' || t.abstract === true) continue;
    for (const v of verdictsOfClass(t, names, byOperationId, rules)) {
      if (v.unlinked) { unlinked.push(v.unlinked); continue; }
      const key = `${v.link.endpoint} ${v.link.handler}`;
      const prev = links.get(key);
      if (!prev || rank[v.link.grade] > rank[prev.grade]) links.set(key, v.link);
    }
  }
  return {
    links: [...links.values()].sort((a, b) => cmp(a.endpoint, b.endpoint) || cmp(a.handler, b.handler)),
    unlinked: unlinked.sort((a, b) => cmp(a.handler, b.handler) || cmp(a.rule, b.rule) || cmp(a.interface, b.interface)),
  };
}

// ---------------------------------------------------------------------------
// The examples
// ---------------------------------------------------------------------------

const strip = (id) => id.slice('endpoint:'.length);
const canonical = (list) => JSON.stringify([...list].map((e) => JSON.stringify(e, Object.keys(e).sort())).sort());

/** What one example gives under one rule, in the example's own words. */
function exampleGot(entry, facts, documents) {
  const { links, unlinked } = deriveContractLinks(facts, operationsOf(documents), [entry]);
  return [
    ...links.map((l) => ({ handler: l.handler, endpoint: strip(l.endpoint) })),
    ...unlinked.map((u) => ({ handler: u.handler, unlinked: u.reason })),
  ];
}

/**
 * Every example, its Java through the real worker once (`env.javaFacts`) and
 * its documents through the engine's own reader (`env.openApiDocument`, handed
 * in because the reader is an adapter). Without either, NOT RUN, which is not
 * a pass. Each example is a project of its own.
 */
function runExamples(entries, env) {
  if (!env || typeof env.openApiDocument !== 'function') return { notRun: 'no OpenAPI reader was handed in' };
  const files = entries.flatMap((entry) => entry.rule.examples.map((ex, i) => ({ name: `${entry.id}/example${i}.java`, text: ex.source })));
  const facts = typeof env.javaFacts === 'function' ? env.javaFacts(files) : null;
  if (facts === null) return { notRun: 'no Java worker: a JDK is needed to parse the examples (see docs/setup/java-lane.md)' };
  return {
    results: new Map(entries.map((entry) => [entry.id, entry.rule.examples.map((ex, i) => {
      const own = facts.filter((r) => r.file === `${entry.id}/example${i}.java`);
      const documents = Object.entries(ex.documents).map(([p, text]) => env.openApiDocument(text, { path: p }));
      const got = exampleGot(entry, own, documents);
      return { example: ex, passed: canonical(got) === canonical(ex.expect), got };
    })])),
  };
}

export const javaContractLink = Object.freeze({
  name: 'java.contract-link',
  lane: 'java',
  stage: 'openapi-bridge',
  // Only a naming convention joins the two ends: the interface that would
  // state the pairing is generated at build time and never read.
  gradeCap: 'HEURISTIC',
  validateParams,
  validateExample,
  compile,
  runExamples,
});
