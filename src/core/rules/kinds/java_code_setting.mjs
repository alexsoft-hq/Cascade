// java_code_setting.mjs — the `java.code-setting` rule kind: a call that makes, in code, a setting this engine reads from the profile instead.
//
// Some of what decides a project's routes is set by configuration code, not
// declared: `RequestMappingHandlerMapping.setPathPrefixes(...)` puts a prefix
// before the routes of the controllers a lambda picks, with the prefix read
// from a property. No reading of the source can say what that sets, so the
// profile has a key for it, and the one thing the engine CAN do is notice the
// call and say which key to fill in. This kind knows HOW such a call is found:
// by the method names each file invokes, as the Java worker records them
// (`invocations`). The rule packs say WHICH names set WHICH profile key
// (src/core/rules/packs/).
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

function callErrors(calls) {
  if (!Array.isArray(calls) || calls.length === 0) return ['params.calls must be a non-empty list of {on, method}'];
  const seen = new Set();
  return calls.flatMap((c, i) => {
    if (!isObj(c)) return [`params.calls[${i}] must be an object {on, method}`];
    const errors = unknownKeys(c, ['on', 'method', 'why']).map((k) => `params.calls[${i}] has an unknown key "${k}"`);
    if (typeof c.method !== 'string' || !JAVA_NAME.test(c.method)) errors.push(`params.calls[${i}].method must be a Java method name`);
    else if (seen.has(c.method)) errors.push(`params.calls[${i}].method "${c.method}" is listed twice`);
    else seen.add(c.method);
    if (typeof c.on !== 'string' || !JAVA_TYPE.test(c.on)) errors.push(`params.calls[${i}].on must name the type that declares the method`);
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
    if (!isObj(e) || typeof e.method !== 'string' || !Number.isInteger(e.line) || unknownKeys(e, ['method', 'line']).length > 0) {
      errors.push(`expect[${i}] must be {method, line}`);
    }
  });
  return errors;
}

/** The rule, ready to read `invocations` records. */
function compile(rule) {
  const on = new Map(rule.params.calls.map((c) => [c.method, c.on]));
  return { rule: rule.id, setting: rule.params.setting, effect: rule.params.effect, on };
}

/** What one `invocations` record holds that one compiled rule names. */
function foundIn(record, compiled) {
  const names = Array.isArray(record.names) ? record.names : [];
  const lines = Array.isArray(record.lines) ? record.lines : [];
  return names.flatMap((method, i) => (compiled.on.has(method) ? [{
    rule: compiled.rule, setting: compiled.setting, effect: compiled.effect,
    method, on: compiled.on.get(method), file: record.file ?? null, line: Number.isInteger(lines[i]) ? lines[i] : null,
  }] : []));
}

const byPlace = (a, b) => (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0)
  || String(a.file).localeCompare(String(b.file)) || (a.line ?? 0) - (b.line ?? 0) || a.method.localeCompare(b.method);

/**
 * Every call the rules name, in the Java worker's records: which rule, which
 * setting, the method and the type that declares it, and where.
 *
 * @param {object[]} javaFacts  the assembled worker records
 * @param {{compiled:object}[]} rules  the `java.code-setting` rules
 * @returns {{rule:string, setting:string, effect:string, method:string, on:string, file:(string|null), line:(number|null)}[]}
 */
export function codeSettingsIn(javaFacts, rules) {
  const records = (Array.isArray(javaFacts) ? javaFacts : []).filter((r) => r && r.kind === 'invocations');
  return rules.flatMap((entry) => records.flatMap((r) => foundIn(r, entry.compiled))).sort(byPlace);
}

const canonical = (list) => JSON.stringify(list.map((e) => `${e.method}:${e.line}`).sort());

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
      const got = codeSettingsIn(own, [entry]).map((f) => ({ method: f.method, line: f.line }));
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
