// java_code_setting.mjs — the `java.code-setting` rule kind: a call that makes, in code, a setting this engine reads from the profile instead.
//
// Some of what decides a project's routes is set by configuration code, not
// declared: `RequestMappingHandlerMapping.setPathPrefixes(...)` puts a prefix
// before the routes of the controllers a lambda picks, with the prefix often
// read from a property. This engine does not read what such a call sets (a
// constant prefix is readable in principle; this engine reads neither it nor
// the predicate), so the profile has a key for it, and the one thing the engine
// does is notice the call and say which key to fill in. This kind knows HOW such
// a call is found: by the method names each file invokes, as the Java worker
// records them (`invocations`). The rule packs say WHICH names set WHICH profile
// key (src/core/rules/packs/).
//
// A NAME IS NOT A RECEIVER. `addPathPrefix("/backup")` on a class's own method
// is not Spring's. A rule names, in full, the types that declare each method
// (`types`), and the worker records what each call's receiver is declared as
// (javafacts/19, /21): a call is the setting (`proof: 'receiver'`) when that
// declared type is one of them, or a type of the tree that extends one however
// far up; a type name is read the way javac reads it in that file (a type the
// file declares, a single-type import and a type of its own package all shadow
// a package imported whole). A call on `this`, on a field a superclass declares
// and on a `var` its `new` types are read the same way. A receiver the file does
// not state (a chain, an untyped lambda parameter) proves nothing either way: in
// a file whose name for the type means the rule's it is said as a lower note
// (`proof: 'import'`), and elsewhere it is not said. A receiver declared as
// another type is not the setting; one the tree does not show is missed, never
// guessed.
//
// It draws no edge and grades nothing. What it finds becomes a diagnostic when
// the profile leaves the key undeclared (src/core/code_settings.mjs); a
// declared key is the project's word and the call is not argued with.

import { PROFILE_DEFAULTS } from '../../profile.mjs';

const JAVA_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const JAVA_TYPE = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/;
const unknownKeys = (obj, allowed) => Object.keys(obj).filter((k) => !allowed.includes(k));
const isText = (v) => typeof v === 'string' && v.trim() !== '';
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The type that declares a call's method: its simple name `on`, and in `types` each full name it has (`<package>.<on>`), once. */
function declaringTypeErrors(c, i) {
  if (typeof c.on !== 'string' || !JAVA_NAME.test(c.on)) return [`params.calls[${i}].on must be the simple name of the type that declares the method`];
  const ok = Array.isArray(c.types) && c.types.length > 0 && new Set(c.types).size === c.types.length
    && c.types.every((t) => typeof t === 'string' && JAVA_TYPE.test(t) && t.endsWith(`.${c.on}`));
  return ok ? [] : [`params.calls[${i}].types must list, once each, the full name of every type that declares the method, each ending in .${c.on}`];
}

function callErrors(calls) {
  if (!Array.isArray(calls) || calls.length === 0) return ['params.calls must be a non-empty list of {on, method, types}'];
  const seen = new Set();
  return calls.flatMap((c, i) => {
    if (!isObj(c)) return [`params.calls[${i}] must be an object {on, method, types}`];
    const errors = unknownKeys(c, ['on', 'method', 'types', 'why']).map((k) => `params.calls[${i}] has an unknown key "${k}"`);
    if (typeof c.method !== 'string' || !JAVA_NAME.test(c.method)) errors.push(`params.calls[${i}].method must be a Java method name`);
    else if (seen.has(c.method)) errors.push(`params.calls[${i}].method "${c.method}" is listed twice`);
    else seen.add(c.method);
    errors.push(...declaringTypeErrors(c, i));
    if (c.why !== undefined && !isText(c.why)) errors.push(`params.calls[${i}].why must be text`);
    return errors;
  });
}

/** What is wrong with a rule's params, as sentences; empty when nothing is. */
function validateParams(params) {
  if (!isObj(params)) return ['params must be an object'];
  const errors = unknownKeys(params, ['setting', 'effect', 'calls']).map((k) => `params has an unknown key "${k}"`);
  if (typeof params.setting !== 'string' || !Object.hasOwn(PROFILE_DEFAULTS, params.setting)) {
    errors.push(`params.setting must be a key of the profile, got ${JSON.stringify(params.setting)}`);
  }
  if (!isText(params.effect)) errors.push('params.effect must say, in a clause, what the call sets and what that leaves out of the pack');
  return [...errors, ...callErrors(params.calls)];
}

/** What is wrong with one example; empty when nothing is. */
function validateExample(example) {
  if (!isObj(example)) return ['an example must be an object'];
  const errors = unknownKeys(example, ['source', 'expect', 'why']).map((k) => `an example has an unknown key "${k}"`);
  if (!isText(example.source)) errors.push('an example needs a Java "source"');
  if (!Array.isArray(example.expect)) return [...errors, 'an example needs "expect", the calls its source makes that the rule names (empty for none)'];
  example.expect.forEach((e, i) => {
    if (!isObj(e) || typeof e.method !== 'string' || !Number.isInteger(e.line) || !PROOFS.includes(e.proof)
      || unknownKeys(e, ['method', 'line', 'proof']).length > 0) {
      errors.push(`expect[${i}] must be {method, line, proof} with proof one of ${PROOFS.join(', ')}`);
    }
  });
  return errors;
}

/** The rule, ready to read `invocations` records. */
function compile(rule) {
  const calls = new Map(rule.params.calls.map((c) => [c.method, { on: c.on, types: c.types }]));
  return { rule: rule.id, setting: rule.params.setting, effect: rule.params.effect, calls };
}

/** How a call was read as the setting: its receiver's declared type says so, or only its file's imports allow it. */
const PROOFS = Object.freeze(['receiver', 'import']);
/** What the worker writes for a receiver the file does not state. */
const UNSTATED = '?';
/** How far up a class hierarchy a receiver is followed: past it, missed rather than guessed. */
const HIERARCHY_CAP = 16;

/**
 * The worker's records, indexed to read a type name the way javac reads it in
 * one file: its package, its single-type imports, the packages it imports whole,
 * the types it declares itself; every type of the tree by name and by package;
 * and every field a class declares, with the type it is declared as.
 */
function javaScope(facts) {
  const sc = { files: new Map(), types: new Map(), byPackage: new Map(), fields: new Map() };
  for (const r of facts) if (r && typeof r.file === 'string') indexRecord(sc, r);
  return sc;
}

/** One file's names, made on first sight. */
function fileScope(sc, file) {
  if (!sc.files.has(file)) sc.files.set(file, { pkg: null, single: new Map(), wild: new Set(), own: new Map() });
  return sc.files.get(file);
}

/** One worker record into the scope: an import, a type or a field; anything else is not read here. */
function indexRecord(sc, r) {
  if (r.kind === 'import' && typeof r.fqn === 'string') {
    const f = fileScope(sc, r.file);
    if (r.simple === '*') f.wild.add(r.fqn); else f.single.set(r.simple, r.fqn);
  } else if (r.kind === 'type' && typeof r.fqn === 'string') indexType(sc, r, fileScope(sc, r.file));
  else if (r.kind === 'field' && typeof r.owner === 'string') sc.fields.set(`${r.owner}#${r.name}`, r);
}

/** One type record into the scope: by name, in its file, and in its package when it is a top-level type. */
function indexType(sc, r, file) {
  sc.types.set(r.fqn, r);
  const simple = r.fqn.slice(r.fqn.lastIndexOf('.') + 1);
  file.pkg = r.package ?? file.pkg;
  file.own.set(simple, r.fqn);
  if (typeof r.package !== 'string' || r.fqn !== (r.package ? `${r.package}.${simple}` : simple)) return;
  if (!sc.byPackage.has(r.package)) sc.byPackage.set(r.package, new Map());
  sc.byPackage.get(r.package).set(simple, r.fqn);
}

/**
 * A type name as one file means it, in the order javac reads it: written in
 * full; a type the file declares; a single-type import; a type of the file's
 * own package; then a package imported whole, when exactly one of them holds a
 * type of that name the tree or the rule knows. Null when none does, or two do.
 */
function resolveName(sc, file, written, call) {
  if (written.includes('.')) return written;
  const f = sc.files.get(file);
  if (!f) return null;
  const direct = f.own.get(written) ?? f.single.get(written) ?? sc.byPackage.get(f.pkg)?.get(written);
  if (direct) return direct;
  const known = (q) => sc.types.has(q) || call.types.includes(q);
  const candidates = [...f.wild].map((p) => `${p}.${written}`).filter(known);
  return candidates.length === 1 ? candidates[0] : null;
}

/** The supertypes a type record writes, extends first. */
const supertypesOf = (t) => [t.extendsWritten ?? t.extends, ...(t.implementsWritten ?? t.implements ?? [])].filter((w) => typeof w === 'string');

/** Whether a type is one of the call's types, or a type of the tree that extends or implements one, however far up. */
function reachesType(sc, fqn, call, depth = 0) {
  if (call.types.includes(fqn)) return true;
  const t = sc.types.get(fqn);
  if (!t || depth >= HIERARCHY_CAP) return false;
  return supertypesOf(t).some((w) => {
    const q = resolveName(sc, t.file, w, call);
    return q !== null && reachesType(sc, q, call, depth + 1);
  });
}

/**
 * The type of the field a superclass of `owner` declares by that name, read in
 * the file that declares it: undefined when the tree shows no such field (the
 * name may be an outer class's field, or a superclass outside the tree's), null
 * when the field's type does not resolve.
 */
function inheritedFieldType(sc, owner, name, call) {
  let t = sc.types.get(owner);
  for (let depth = 0; t && depth < HIERARCHY_CAP; depth += 1) {
    const ext = t.extendsWritten ?? t.extends;
    const up = typeof ext === 'string' ? resolveName(sc, t.file, ext, call) : null;
    const field = up ? sc.fields.get(`${up}#${name}`) : undefined;
    if (field) return typeof field.typeSimple === 'string' ? resolveName(sc, field.file, field.typeSimple, call) : null;
    t = up ? sc.types.get(up) : undefined;
  }
  return undefined;
}

/** A receiver's type, resolved, as proof: 'receiver' when it is or extends one of the call's types. */
const typeProof = (q, sc, call) => (typeof q === 'string' && reachesType(sc, q, call) ? 'receiver' : null);

/** What a call on a name its class never binds proves: a superclass's field, or, when the tree shows none, what an unstated receiver does. */
function fieldProof(receiver, call, sc, file) {
  const [owner, name] = receiver.slice('field:'.length).split('#');
  const q = inheritedFieldType(sc, owner, name, call);
  return q === undefined ? proofOf(UNSTATED, call, sc, file) : typeProof(q, sc, call);
}

/** What one receiver proves: 'receiver', 'import', or null for a call that is not the setting. */
function proofOf(receiver, call, sc, file) {
  if (receiver === UNSTATED) return call.types.includes(resolveName(sc, file, call.on, call)) ? 'import' : null;
  if (receiver.startsWith('this:')) return typeProof(receiver.slice('this:'.length), sc, call);
  if (receiver.startsWith('field:')) return fieldProof(receiver, call, sc, file);
  return typeProof(resolveName(sc, file, receiver, call), sc, call);
}

/** A name's receivers, `[receiver, line]` each; a record from before javafacts/19 states none. */
const receiversAt = (record, i) => (Array.isArray(record.receivers?.[i]) ? record.receivers[i] : [[UNSTATED, record.lines?.[i]]]);

/** Whether one site beats the best so far: a proved receiver over an import, then the earlier line. */
const beats = (site, best) => !best || (site.proof === 'receiver' && best.proof !== 'receiver')
  || (site.proof === best.proof && (site.line ?? 0) < (best.line ?? 0));

/** The best-proved site of one name: the first call whose receiver proves it, else the first its imports allow. */
function siteOf(record, i, call, sc) {
  let best = null;
  for (const [receiver, line] of receiversAt(record, i)) {
    const proof = typeof receiver === 'string' ? proofOf(receiver, call, sc, record.file) : null;
    const site = proof ? { proof, line: Number.isInteger(line) ? line : null } : null;
    if (site && beats(site, best)) best = site;
  }
  return best;
}

/** What one `invocations` record holds that one compiled rule names, as proved as its receivers allow. */
function foundIn(record, compiled, sc) {
  const names = Array.isArray(record.names) ? record.names : [];
  return names.flatMap((method, i) => {
    const call = compiled.calls.get(method);
    const site = call ? siteOf(record, i, call, sc) : null;
    if (!site) return [];
    return [{
      rule: compiled.rule, setting: compiled.setting, effect: compiled.effect,
      method, on: call.on, file: record.file ?? null, line: site.line, proof: site.proof,
    }];
  });
}

const byPlace = (a, b) => (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0)
  || String(a.file).localeCompare(String(b.file)) || (a.line ?? 0) - (b.line ?? 0) || a.method.localeCompare(b.method);

/**
 * Every call the rules name, in the Java worker's records, with how it was
 * proved: its receiver's declared type (`receiver`), or only its file's imports
 * where the receiver is not stated (`import`). A call whose receiver is declared
 * as another type is some other method, and is not here.
 *
 * @param {object[]} javaFacts  the assembled worker records
 * @param {{compiled:object}[]} rules  the `java.code-setting` rules
 * @returns {{rule:string, setting:string, effect:string, method:string, on:string, file:(string|null), line:(number|null), proof:string}[]}
 */
export function codeSettingsIn(javaFacts, rules) {
  const facts = Array.isArray(javaFacts) ? javaFacts : [];
  const records = facts.filter((r) => r && r.kind === 'invocations');
  const sc = javaScope(facts);
  return rules.flatMap((entry) => records.flatMap((r) => foundIn(r, entry.compiled, sc))).sort(byPlace);
}

const canonical = (list) => JSON.stringify(list.map((e) => `${e.method}:${e.line}:${e.proof}`).sort());

/**
 * Every example run through the real Java worker once, as `java.type-role`
 * runs its own: without a JDK they are NOT RUN, which is not a pass.
 */
function runExamples(entries, env) {
  const files = entries.flatMap((entry) => entry.rule.examples.map((ex, i) => ({ name: `${entry.id}/example${i}.java`, text: ex.source })));
  const facts = env && typeof env.javaFacts === 'function' ? env.javaFacts(files) : null;
  if (facts === null) return { notRun: 'no Java worker: a JDK is needed to parse the examples (see docs/setup/java-lane.md)' };
  return {
    results: new Map(entries.map((entry) => [entry.id, entry.rule.examples.map((ex, i) => {
      const own = facts.filter((r) => r.file === `${entry.id}/example${i}.java`);
      const got = codeSettingsIn(own, [entry]).map((f) => ({ method: f.method, line: f.line, proof: f.proof }));
      return { example: ex, passed: canonical(got) === canonical(ex.expect), got };
    })])),
  };
}

export const javaCodeSetting = Object.freeze({
  name: 'java.code-setting',
  lane: 'java',
  stage: 'java-facts',
  // A call noticed and said, not an edge: there is no grade to cap.
  gradeCap: null,
  validateParams,
  validateExample,
  compile,
  runExamples,
});
