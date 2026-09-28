// dispatch.mjs — the methods a call through a type may run: the type's own, and those of every class of the project that extends or implements it.
//
// `this.users.findById()` on a field typed with an abstract class runs the
// findById of whichever object was injected, never the abstract declaration,
// which has no body; on a field typed with an interface there is no body at
// all. And `this.m()` in a base class runs a subclass's override whenever
// `this` is an instance of that subclass. So a call through a type reaches,
// for the type itself and for each class of the project that extends or
// implements it (directly or through another class or interface), the nearest
// declaration of the method. That is a candidate set, graded SOUND_SET like
// every call edge of this lane, and never promoted, not even when it holds one
// method (docs/concepts.md).
//
// The set rests on what the project's own `extends` and `implements` clauses
// say. TypeScript also accepts, for a type, an object of the right shape that
// names neither; a class like that is not in the set. What a NestJS module
// binds to the type (src/adapters/ts/nest_providers.mjs) can narrow the set to
// the class it binds, and the edge says which module did.

import { methodOf } from './project.mjs';

const MAX_TYPES = 5000;

function addChild(children, parentKey, child) {
  if (!children.has(parentKey)) children.set(parentKey, []);
  children.get(parentKey).push(child);
}

/** Each class or interface of the project, keyed, with the classes and interfaces that name it in their own extends or implements. */
function childrenOf(project) {
  const children = new Map();
  for (const [file, f] of project.files) {
    for (const cls of f.classes.values()) {
      for (const name of [cls.extends, ...(cls.implements ?? [])]) {
        const parent = name ? project.typeOf(file, name) : null;
        if (parent && parent.key !== cls.key) addChild(children, parent.key, cls);
      }
    }
    for (const itf of f.interfaces.values()) {
      for (const name of itf.extends ?? []) {
        const parent = project.typeOf(file, name);
        if (parent && parent.key !== itf.key) addChild(children, parent.key, itf);
      }
    }
  }
  return children;
}

/**
 * The project's subtypes: `subtypesOf(key)` is every class of the project that
 * extends or implements the class or interface `key`, directly or through
 * another, in key order. Interfaces are walked through, never returned: they
 * have no code to run.
 */
export function subtypeIndex(project) {
  const children = childrenOf(project);
  const memo = new Map();
  return (key) => {
    if (memo.has(key)) return memo.get(key);
    const seen = new Map();
    const queue = [...(children.get(key) ?? [])];
    while (queue.length > 0 && seen.size < MAX_TYPES) {
      const t = queue.shift();
      if (seen.has(t.key) || t.key === key) continue;
      seen.set(t.key, t);
      queue.push(...(children.get(t.key) ?? []));
    }
    const classes = [...seen.values()].filter((t) => t.kind === 'class').sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    memo.set(key, classes);
    return classes;
  };
}

/** The method `name` each of `classes` runs: its nearest declaration, once per declaring class, in key order. */
export function methodsRunBy(project, classes, name) {
  const hits = new Map();
  for (const c of classes) {
    const hit = methodOf(project, c, name);
    if (hit) hits.set(hit.cls.key, hit);
  }
  return [...hits.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, hit]) => hit);
}

/**
 * What a call of `name` through a value of `type` may run. `own` is the
 * method the type itself resolves to (null for an interface, or an abstract
 * method with no body), `all` the nearest declaration for the type and for
 * each class that extends or implements it. When `all` is `own` alone, no
 * subtype changes the answer, and the call is linked as it always was.
 */
export function typeTargets(project, subtypesOf, type, name) {
  const own = type.kind === 'class' ? methodOf(project, type, name) : null;
  const classes = type.kind === 'class' ? [type, ...subtypesOf(type.key)] : subtypesOf(type.key);
  const all = methodsRunBy(project, classes, name);
  return { own, all, plain: Boolean(own) && all.length === 1 && all[0].cls.key === own.cls.key };
}
