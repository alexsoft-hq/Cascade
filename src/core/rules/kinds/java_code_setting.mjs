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
// (javafacts/19): a call is the setting (`proof: 'receiver'`) when that declared
// type is one of them, written in full or by a simple name the file imports
// (the type or its package) or shares a package with, or when the call is on a
// class whose own extends or implements clause names one of them that way. A
// receiver the file does not state (a chain, an untyped lambda parameter) proves
// nothing either way: in a file that can name one of the types it is said as a
// lower note (`proof: 'import'`), and elsewhere it is not said. A receiver
// declared as another type, or as a subclass of the rule's type that the source
// does not show in this file, is missed, never guessed.
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

const NOTHING_VISIBLE = Object.freeze({ types: new Set(), packages: new Set() });
/** How a call was read as the setting: its receiver's declared type says so, or only its file's imports allow it. */
const PROOFS = Object.freeze(['receiver', 'import']);
/** What the worker writes for a receiver the file does not state. */
const UNSTATED = '?';
const packageOf = (fqn) => fqn.slice(0, fqn.lastIndexOf('.'));

/**
 * What each file can name without spelling it out, from the worker's records:
 * the types it imports one by one, and the packages it imports whole or sits in.
 */
function visibleByFile(javaFacts) {
  const byFile = new Map();
  const at = (file) => {
    if (!byFile.has(file)) byFile.set(file, { types: new Set(), packages: new Set() });
    return byFile.get(file);
  };
  for (const r of javaFacts) {
    if (!r || typeof r.file !== 'string') continue;
    if (r.kind === 'import' && typeof r.fqn === 'string') (r.simple === '*' ? at(r.file).packages : at(r.file).types).add(r.fqn);
    else if (r.kind === 'type' && typeof r.package === 'string') at(r.file).packages.add(r.package);
  }
  return byFile;
}

/** Whether a file can name one of the types that declare the method. */
const receiverShown = (call, visible) => call.types.some((t) => visible.types.has(t) || visible.packages.has(packageOf(t)));

/** A type as a file writes it, read as one of the call's types: in full, or by the simple name the file can name it by. */
const namesType = (written, call, visible) => (written.includes('.') ? call.types.includes(written) : written === call.on && receiverShown(call, visible));

/** Whether a class's own extends or implements clause names one of the call's types. */
function classIsType(fqn, call, visible, typesByFqn) {
  const t = typesByFqn.get(fqn);
  if (!t) return false;
  const written = [t.extendsWritten ?? t.extends, ...(t.implementsWritten ?? t.implements ?? [])];
  return written.some((w) => typeof w === 'string' && namesType(w, call, visible));
}

/** What one receiver proves: 'receiver', 'import', or null for a call that is not the setting. */
function proofOf(receiver, call, visible, typesByFqn) {
  if (receiver === UNSTATED) return receiverShown(call, visible) ? 'import' : null;
  if (receiver.startsWith('this:')) return classIsType(receiver.slice('this:'.length), call, visible, typesByFqn) ? 'receiver' : null;
  return namesType(receiver, call, visible) ? 'receiver' : null;
}

/** A name's receivers, `[receiver, line]` each; a record from before javafacts/19 states none. */
const receiversAt = (record, i) => (Array.isArray(record.receivers?.[i]) ? record.receivers[i] : [[UNSTATED, record.lines?.[i]]]);

/** Whether one site beats the best so far: a proved receiver over an import, then the earlier line. */
const beats = (site, best) => !best || (site.proof === 'receiver' && best.proof !== 'receiver')
  || (site.proof === best.proof && (site.line ?? 0) < (best.line ?? 0));

/** The best-proved site of one name: the first call whose receiver proves it, else the first its imports allow. */
function siteOf(record, i, call, visible, typesByFqn) {
  let best = null;
  for (const [receiver, line] of receiversAt(record, i)) {
    const proof = typeof receiver === 'string' ? proofOf(receiver, call, visible, typesByFqn) : null;
    const site = proof ? { proof, line: Number.isInteger(line) ? line : null } : null;
    if (site && beats(site, best)) best = site;
  }
  return best;
}

/** What one `invocations` record holds that one compiled rule names, as proved as its receivers allow. */
function foundIn(record, compiled, visible, typesByFqn) {
  const names = Array.isArray(record.names) ? record.names : [];
  return names.flatMap((method, i) => {
    const call = compiled.calls.get(method);
    const site = call ? siteOf(record, i, call, visible, typesByFqn) : null;
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
  const visible = visibleByFile(facts);
  const typesByFqn = new Map(facts.filter((r) => r && r.kind === 'type' && typeof r.fqn === 'string').map((r) => [r.fqn, r]));
  const seen = (r) => visible.get(r.file) ?? NOTHING_VISIBLE;
  return rules.flatMap((entry) => records.flatMap((r) => foundIn(r, entry.compiled, seen(r), typesByFqn))).sort(byPlace);
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
