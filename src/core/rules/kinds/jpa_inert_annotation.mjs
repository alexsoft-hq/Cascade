// jpa_inert_annotation.mjs — the `jpa.inert-annotation` rule kind: which annotation on a JPA attribute cannot change its mapping, read from the annotation's own declaration.
//
// The JPA bridge does not trust a column that carries an annotation it does not
// know: a name nobody listed may be one that renames or moves the column. Most
// such names are a project's own markers, and Hibernate reads a project's
// annotation in two ways only: through a meta-annotation on the annotation's
// declaration (@AttributeBinderType, @IdGeneratorType, @ValueGenerationType,
// @TypeBinderType, @Type and the rest; HCANNHelper.findContainingAnnotations
// looks one level up), or from code the project hands Hibernate at boot (an
// Integrator, a MetadataBuilderContributor, an AdditionalMappingContributor).
//
// This kind knows HOW that is read, positively: an annotation is inert when the
// tree declares it (read the way javac reads the name in the attribute's file),
// every annotation on its declaration is from a package the rule lists, and no
// class of the tree implements an extension point the rule lists. The rule pack
// says WHICH packages and WHICH extension points (src/core/rules/packs/jpa.json).
// An annotation from a jar, one with any other meta-annotation, or any in a tree
// that implements an extension point stays unknown.

import { javaNames, meaningOf } from '../java_names.mjs';
import { supertypesOf } from './java_type_role.mjs';

const unknownKeys = (obj, allowed) => Object.keys(obj).filter((k) => !allowed.includes(k));
const isText = (v) => typeof v === 'string' && v.trim() !== '';
const PACKAGE = /^[a-z_$][A-Za-z0-9_$]*(?:\.[a-z_$][A-Za-z0-9_$]*)*$/;
const QUALIFIED = /^(?:[a-z_$][A-Za-z0-9_$]*\.)+[A-Za-z_$][A-Za-z0-9_$]*$/;
const simpleOf = (fqn) => fqn.slice(fqn.lastIndexOf('.') + 1);
const packageOf = (fqn) => fqn.slice(0, fqn.lastIndexOf('.'));

function pointErrors(points) {
  if (!Array.isArray(points) || points.length === 0) return ['params.extensionPoints must be a non-empty list'];
  return points.flatMap((p, i) => {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return [`params.extensionPoints[${i}] must be an object`];
    const errors = unknownKeys(p, ['type', 'source']).map((k) => `params.extensionPoints[${i}] has an unknown key "${k}"`);
    if (typeof p.type !== 'string' || !QUALIFIED.test(p.type)) errors.push(`params.extensionPoints[${i}].type must be a type's full name`);
    if (!isText(p.source)) errors.push(`params.extensionPoints[${i}].source must say where the type is declared`);
    return errors;
  });
}

function validateParams(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return ['params must be an object'];
  const errors = unknownKeys(params, ['metaAnnotationPackages', 'extensionPoints']).map((k) => `params has an unknown key "${k}"`);
  const pkgs = params.metaAnnotationPackages;
  if (!Array.isArray(pkgs) || pkgs.length === 0) errors.push('params.metaAnnotationPackages must be a non-empty list');
  else for (const p of pkgs) if (typeof p !== 'string' || !PACKAGE.test(p)) errors.push(`params.metaAnnotationPackages has ${JSON.stringify(p)}, which is not a package name`);
  return [...errors, ...pointErrors(params.extensionPoints)];
}

function validateExample(example) {
  if (!example || typeof example !== 'object' || Array.isArray(example)) return ['an example must be an object'];
  const errors = unknownKeys(example, ['source', 'expect', 'why']).map((k) => `an example has an unknown key "${k}"`);
  if (!isText(example.source)) errors.push('an example needs a Java "source"');
  if (!Array.isArray(example.expect) || !example.expect.every(isText)) errors.push('an example needs "expect", the list of "<class>.<attribute> @<annotation>" it makes inert (empty for none)');
  return errors;
}

/** Whether every annotation on an annotation type's declaration is from a listed package, as its file means the name. */
function onlyListedMeta(t, packages, names) {
  const written = Array.isArray(t.annotationsWritten) ? t.annotationsWritten : [];
  return (t.annotations ?? []).every((simple, i) => {
    const m = meaningOf(t, { simple, written: written[i] ?? null }, names);
    if (m?.fqn) return packages.has(packageOf(m.fqn));
    return Array.isArray(m?.packages) && m.packages.every((p) => packages.has(p));
  });
}

/** Whether one supertype a type names may be the extension point: its file means that type, or cannot say which it means. */
function mayBePoint(t, sup, point, names) {
  if (sup.simple !== simpleOf(point)) return false;
  const m = meaningOf(t, sup, names);
  return !m?.fqn || m.fqn === point;
}

/**
 * What one rule reads from a tree: the classes that implement an extension
 * point, and the annotation types that are inert (none when any class does).
 * `inertOf(type, simple, written)` is the inert annotation type a name on an
 * attribute of that type record means, or null.
 */
export function readInertAnnotations(javaFacts, rule) {
  const packages = new Set(rule.params.metaAnnotationPackages);
  const points = rule.params.extensionPoints.map((p) => p.type);
  const names = javaNames(javaFacts);
  const types = javaFacts.filter((r) => r && r.kind === 'type');
  const implementers = types.filter((t) => supertypesOf(t).some((sup) => points.some((p) => mayBePoint(t, sup, p, names))))
    .map((t) => t.fqn).sort();
  // The annotation types that pass (a) and (b); (c) then decides whether any is inert.
  const candidates = types.filter((t) => t.annotationType === true && onlyListedMeta(t, packages, names)).map((t) => t.fqn).sort();
  const inert = new Set(implementers.length > 0 ? [] : candidates);
  const inertOf = (t, simple, written = null) => {
    if (!t || inert.size === 0) return null;
    const m = meaningOf(t, { simple, written }, names);
    return m?.fqn && inert.has(m.fqn) ? m.fqn : null;
  };
  return { rule: rule.id, implementers, candidates, inert: [...inert].sort(), inertOf };
}

/** The rule, ready to read a tree: a function from the Java worker's records to what `readInertAnnotations` gives. */
function compile(rule) {
  return (javaFacts) => readInertAnnotations(javaFacts, rule);
}

/** Every "<class>.<attribute> @<annotation>" an example's entity records carry that the rule makes inert. */
function inertUsages(facts, read) {
  const typeOf = new Map(facts.filter((r) => r.kind === 'type').map((t) => [t.fqn, t]));
  const out = [];
  for (const rec of facts.filter((r) => r.kind === 'entity')) {
    for (const a of rec.attributes ?? []) {
      (a.annotations ?? []).forEach((simple, i) => {
        const fqn = read.inertOf(typeOf.get(rec.fqn), simple, (a.annotationsWritten ?? [])[i] ?? null);
        if (fqn) out.push(`${rec.fqn}.${a.name} @${fqn}`);
      });
    }
  }
  return out.sort();
}

/**
 * Every example through the real Java worker once (`env.javaFacts`), each
 * example a tree of its own. Without a JDK they are NOT RUN, never passed.
 */
function runExamples(entries, env) {
  const files = entries.flatMap((entry) => entry.rule.examples.map((ex, i) => ({ name: `${entry.id}/example${i}.java`, text: ex.source })));
  const facts = env && typeof env.javaFacts === 'function' ? env.javaFacts(files) : null;
  if (facts === null) return { notRun: 'no Java worker: a JDK is needed to parse the examples (see docs/setup/java-lane.md)' };
  return {
    results: new Map(entries.map((entry) => [entry.id, entry.rule.examples.map((ex, i) => {
      const own = facts.filter((r) => r.file === `${entry.id}/example${i}.java`);
      const got = inertUsages(own, entry.compiled(own));
      return { example: ex, passed: JSON.stringify(got) === JSON.stringify([...ex.expect].sort()), got };
    })])),
  };
}

export const jpaInertAnnotation = Object.freeze({
  name: 'jpa.inert-annotation',
  lane: 'java',
  // Read by the JPA bridge while it decides how sure each column is.
  stage: 'jpa-bridge',
  // It only classifies an annotation; the columns carry their own grade.
  gradeCap: null,
  validateParams,
  validateExample,
  compile,
  runExamples,
});
