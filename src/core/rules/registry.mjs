// registry.mjs — the rule packs this engine reads, checked whole before anything uses them.
//
// A rule pack is a JSON file: one framework's knowledge, as rules of the kinds
// in ./kinds/. The engine carries its own packs in ./packs/. Nothing reads a
// rule that has not passed every check here, and a pack that fails is refused
// with EVERY problem it has, named by file and rule, so the person editing it
// fixes it in one pass rather than one error at a time.
//
// THE SHAPE IS CLOSED. A pack or a rule with a key this file does not know is
// refused, not ignored: an ignored key is a rule that silently says less than
// its author thinks, and a shape that grows keys nobody checks is how a rule
// format turns into a programming language.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GRADE_RANK } from '../graph.mjs';
import { KINDS } from './kinds/index.mjs';

/** Where the packs the engine carries live. They are part of the engine: its print covers them. */
export const BUILTIN_PACKS_DIR = fileURLToPath(new URL('./packs/', import.meta.url));

const PACK_KEYS = Object.freeze(['pack', 'version', 'description', 'rules']);
const RULE_KEYS = Object.freeze(['id', 'kind', 'description', 'why', 'grade', 'params', 'examples']);
/** A pack's name and the part of a rule id after the pack's name. */
const NAME = /^[a-z][a-z0-9-]*$/;

/** A pack, or a set of packs, that cannot be read, with every reason. */
export class RuleError extends Error {
  constructor(problems) {
    super(`rule packs refused:\n${problems.map((p) => `  ${p}`).join('\n')}`);
    this.name = 'RuleError';
    this.code = 'bad-rule';
    this.problems = problems;
  }
}

const isText = (s) => typeof s === 'string' && s.trim() !== '';
const unknownKeys = (obj, allowed) => Object.keys(obj).filter((k) => !allowed.includes(k));

function packErrors(pack) {
  if (!pack || typeof pack !== 'object' || Array.isArray(pack)) return ['is not a JSON object'];
  const errors = unknownKeys(pack, PACK_KEYS).map((k) => `has an unknown key "${k}"`);
  if (typeof pack.pack !== 'string' || !NAME.test(pack.pack)) errors.push('"pack" must be a lower-case name (letters, digits, hyphens)');
  if (!Number.isInteger(pack.version) || pack.version < 1) errors.push('"version" must be a whole number from 1');
  if (!isText(pack.description)) errors.push('"description" must say what the pack is about');
  if (!Array.isArray(pack.rules) || pack.rules.length === 0) errors.push('"rules" must be a non-empty list');
  return errors;
}

/** What a rule's grade may be under its kind's cap. */
function gradeErrors(rule, kind) {
  if (rule.grade === undefined) return [];
  if (kind.gradeCap === null) return [`gives a grade, but a ${kind.name} rule draws no edge to grade`];
  if (!(rule.grade in GRADE_RANK)) return [`gives the grade ${JSON.stringify(rule.grade)}, which is not a grade`];
  return GRADE_RANK[rule.grade] > GRADE_RANK[kind.gradeCap]
    ? [`gives ${rule.grade}, above what a ${kind.name} rule may give (${kind.gradeCap})`] : [];
}

function exampleErrors(rule, kind) {
  if (!Array.isArray(rule.examples) || rule.examples.length === 0) return ['needs at least one example: an example is the test that says the rule still does what it says'];
  return rule.examples.flatMap((ex) => kind.validateExample(ex, rule.params));
}

/** Everything wrong with one rule, as sentences. */
function ruleErrors(rule, packName, kinds) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return ['is not a JSON object'];
  const errors = unknownKeys(rule, RULE_KEYS).map((k) => `has an unknown key "${k}"`);
  const prefix = `${packName}.`;
  if (typeof rule.id !== 'string' || !rule.id.startsWith(prefix) || !NAME.test(rule.id.slice(prefix.length))) {
    errors.push(`"id" must be "${prefix}<name>", the pack's name then a lower-case name`);
  }
  if (!isText(rule.description)) errors.push('"description" must say what the rule means');
  if (rule.why !== undefined && !isText(rule.why)) errors.push('"why" must be text when it is given');
  const kind = kinds[rule.kind];
  if (!kind) return [...errors, `"kind" must be one of ${Object.keys(kinds).join(', ')}, got ${JSON.stringify(rule.kind)}`];
  return [...errors, ...kind.validateParams(rule.params), ...gradeErrors(rule, kind), ...exampleErrors(rule, kind)];
}

/** Every problem in a set of packs, each named by where it is. */
function problemsOf(sources, kinds) {
  const problems = [];
  const owner = new Map();
  for (const { where, pack } of sources) {
    const own = packErrors(pack);
    problems.push(...own.map((e) => `${where}: ${e}`));
    if (own.length > 0) continue;
    for (const [i, rule] of pack.rules.entries()) {
      const name = typeof rule?.id === 'string' ? rule.id : `rules[${i}]`;
      problems.push(...ruleErrors(rule, pack.pack, kinds).map((e) => `${where}: ${name} ${e}`));
      if (typeof rule?.id !== 'string') continue;
      if (owner.has(rule.id)) problems.push(`${where}: ${rule.id} is already defined in ${owner.get(rule.id)}`);
      else owner.set(rule.id, where);
    }
  }
  return problems;
}

/**
 * THE REGISTRY: every rule of every pack, checked and compiled, and looked up
 * by id or by kind. Throws a RuleError with every problem when any pack fails.
 *
 * @param {{where:string, pack:object}[]} sources  each pack with the file it came from
 * @param {object} [kinds]  the kinds to check against (the tests pass their own)
 */
export function buildRegistry(sources, kinds = KINDS) {
  const problems = problemsOf(sources, kinds);
  if (problems.length > 0) throw new RuleError(problems);
  const rules = new Map();
  const packs = sources.map(({ where, pack }) => {
    for (const rule of pack.rules) {
      rules.set(rule.id, { id: rule.id, kind: rule.kind, pack: pack.pack, where, rule, compiled: kinds[rule.kind].compile(rule) });
    }
    return { name: pack.pack, version: pack.version, description: pack.description, where, ruleIds: pack.rules.map((r) => r.id) };
  });
  const ofKind = (name) => [...rules.values()].filter((r) => r.kind === name);
  return { packs, rules, ofKind, kinds };
}

/** Every pack file in one directory, in file-name order, read but not yet checked. */
export function readPackDir(dir) {
  let names;
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch { return []; }
  return names.map((name) => {
    const file = path.join(dir, name);
    try { return { where: name, pack: JSON.parse(fs.readFileSync(file, 'utf8')) }; }
    catch (e) { throw new RuleError([`${name}: is not valid JSON (${e.message})`]); }
  });
}

let builtin = null;
/** The engine's own packs, checked and compiled once per process. */
export function builtinRegistry() {
  if (builtin === null) builtin = buildRegistry(readPackDir(BUILTIN_PACKS_DIR));
  return builtin;
}
