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

import { runsOn } from './project.mjs';

const MAX_TYPES = 5000;

function addChild(children, parentKey, child) {
  if (!children.has(parentKey)) children.set(parentKey, []);
  children.get(parentKey).push(child);
}

/** The value names a value mentions, at any depth. */
function namesIn(v, out = []) {
  if (!v || typeof v !== 'object') return out;
  if (v.k === 'id') out.push(v.v);
  for (const x of [...(Array.isArray(v.v) ? v.v : v.k === 'obj' ? Object.values(v.v) : []), ...(v.args ?? [])]) namesIn(x, out);
  return out;
}

/** One class under every class its chain of extends reaches and under what it implements; into `open` when that chain stops at a call. */
function addClass(project, file, cls, { children, open }) {
  for (const up of project.lineage(cls).slice(1)) addChild(children, up.key, cls);
  for (const name of cls.implements ?? []) {
    const parent = project.typeOf(file, name);
    if (parent && parent.key !== cls.key) addChild(children, parent.key, cls);
  }
  const end = project.openEnd(cls);
  if (end) open.push({ cls, end, handed: new Set(namesIn({ k: 'arr', v: end.args }).map((n) => project.typeOf(end.file, n)?.key).filter(Boolean)) });
}

/**
 * Each class or interface of the project, keyed, with the classes and
 * interfaces under it: each class under every class its chain of extends
 * reaches (a mixin's class and what the mixin was handed among them) and
 * under what it implements, each interface under what it extends. And the
 * classes whose chain stops at a call this engine cannot follow, with the
 * types of the project that call is handed: such a class may extend them.
 */
function childrenOf(project) {
  const out = { children: new Map(), open: [] };
  for (const [file, f] of project.files) {
    for (const cls of f.classes.values()) addClass(project, file, cls, out);
    for (const itf of f.interfaces.values()) {
      for (const name of itf.extends ?? []) {
        const parent = project.typeOf(file, name);
        if (parent && parent.key !== itf.key) addChild(out.children, parent.key, itf);
      }
    }
  }
  return out;
}

/** Every class under `key`, directly or through another, in key order. */
function classesUnder(children, key) {
  const seen = new Map();
  const queue = [...(children.get(key) ?? [])];
  while (queue.length > 0 && seen.size < MAX_TYPES) {
    const t = queue.shift();
    if (seen.has(t.key) || t.key === key) continue;
    seen.set(t.key, t);
    queue.push(...(children.get(t.key) ?? []));
  }
  return [...seen.values()].filter((t) => t.kind === 'class').sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** How an open end is said: what the chain stops at. */
const openSaid = (o) => (o.end.name ? `${o.end.callee}, which this engine cannot take for a class` : `${o.end.callee}(...), a class this engine does not read`);

/**
 * Whether a class whose chain stops where this engine cannot follow it
 * declares `name` itself, or a class of its chain below that point does: then
 * it may be one more class of any type's set, running its own `name`. One that
 * does not runs what the class it cannot follow gives it, which is a class of
 * the tree, and in the set already, or not the project's.
 */
const declaresBelow = (project, o, name) => Boolean(name) && Boolean(runsOn(project, o.cls, name));

/**
 * The project's subtypes: `subtypesOf(key)` is every class of the project that
 * extends or implements the class or interface `key`, directly or through
 * another, in key order. Interfaces are walked through, never returned: they
 * have no code to run. `subtypesOf.openFor(key, name)` says why a class this
 * engine cannot read may be one more: a class whose extends is a call it
 * cannot follow, handed the type or one of its subtypes, or any class whose
 * chain it cannot follow that declares `name`; null when none is.
 */
export function subtypeIndex(project) {
  const { children, open } = childrenOf(project);
  const memo = new Map();
  const subtypesOf = (key) => {
    if (!memo.has(key)) memo.set(key, classesUnder(children, key));
    return memo.get(key);
  };
  subtypesOf.openFor = (key, name = null) => {
    const under = new Set([key, ...subtypesOf(key).map((c) => c.key)]);
    const hit = open.find((o) => [...o.handed].some((k) => under.has(k)) || (!under.has(o.cls.key) && declaresBelow(project, o, name)));
    return hit ? `${hit.cls.key} extends ${openSaid(hit)}, which may override the method` : null;
  };
  return subtypesOf;
}

/** What `this.name()` runs on an object of each of `classes`: once per declaring class, in key order; a class that may replace it is left for `gapAmong`. */
export function methodsRunBy(project, classes, name) {
  const hits = new Map();
  for (const c of classes) {
    const hit = runsOn(project, c, name);
    if (hit && !hit.replaced) hits.set(hit.cls.key, hit);
  }
  return [...hits.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, hit]) => hit);
}

/**
 * Why one of `classes` may run a `name` this engine does not link, or null: a
 * member that may replace it, or a `name` it declares nowhere in the chain
 * this engine follows, which stops at something it cannot take for a class.
 */
export function gapAmong(project, classes, name) {
  for (const c of classes) {
    const hit = runsOn(project, c, name);
    if (hit?.replaced) return hit.replaced;
    const end = hit ? null : project.openEnd(c);
    if (end) return `${c.key} may inherit ${name} from ${openSaid({ end })}`;
  }
  return null;
}

/**
 * What a call of `name` through a value of `type` may run. `own` is what the
 * type itself runs (null for an interface, or an abstract method with no
 * body), `all` the nearest declaration for the type and for each class that
 * extends or implements it, a property holding a function among them. When
 * `all` is `own` alone and no class this engine cannot read may extend the
 * type, no subtype changes the answer: `plain`. `open` says why the set may
 * be short: a class it cannot read, or a member it cannot link.
 */
export function typeTargets(project, subtypesOf, type, name) {
  const classes = type.kind === 'class' ? [type, ...subtypesOf(type.key)] : subtypesOf(type.key);
  const ran = type.kind === 'class' ? runsOn(project, type, name) : null;
  const own = ran && !ran.replaced ? ran : null;
  const all = methodsRunBy(project, classes, name);
  const open = openOf(project, subtypesOf, type, { classes, name });
  return { own, all, open, plain: Boolean(own) && !open && all.length === 1 && all[0].cls.key === own.cls.key };
}

/** Why a type's set for `name` may be short: a class this engine cannot read that may extend it, or a member of the set it cannot link. */
const openOf = (project, subtypesOf, type, { classes, name }) => (subtypesOf.openFor ? subtypesOf.openFor(type.key, name) : null) ?? gapAmong(project, classes, name);
