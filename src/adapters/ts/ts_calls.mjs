// ts_calls.mjs — the TypeScript lane's symbols and the calls between them.
//
// A symbol is a method of a class, `symbol:<file>#<Class.method>`, or a module
// function, `symbol:<file>#<name>`: the web lane's shape, so a file never gets
// two ids. A call is linked when the project says what it reaches:
//
//   this.m()        a method of the class, or of a class it extends
//   this.dep.m()    a method of the class `dep` is typed with, where `dep` is
//                   a constructor parameter property or a property of the class
//   f(), Cls.m()    a function or a static method a name of the file means
//
// Each is MAY_CALL at SOUND_SET, the Java lane's grade for a call through a
// field: a provider can be swapped (`useClass`) and a subclass can override, so
// the target is in the set named, not proven to be the only one. Anything else
// (a local variable, a callback parameter, a package) is counted, not guessed.

import { nodeId } from '../../core/graph.mjs';
import { fieldOf, methodOf } from './project.mjs';

export const methodSymbolId = (file, cls, method) => nodeId('symbol', `${file}#${cls}.${method}`);
export const functionSymbolId = (file, name) => nodeId('symbol', `${file}#${name}`);

/** Every method and module function of the project as a symbol node. */
export function addSymbols(g, project) {
  let count = 0;
  for (const [file, f] of project.files) {
    for (const cls of f.classes.values()) {
      for (const m of cls.methods.values()) {
        g.addNode({ id: methodSymbolId(file, cls.name, m.name), symbol: `${file}#${cls.name}.${m.name}`, owner: cls.key, file, line: m.line ?? null, lane: 'ts' });
        count += 1;
      }
    }
    for (const fn of f.functions.values()) {
      g.addNode({ id: functionSymbolId(file, fn.name), symbol: `${file}#${fn.name}`, file, line: fn.line ?? null, lane: 'ts', exported: fn.exported });
      count += 1;
    }
  }
  return count;
}

/** The symbol a call is written in, or null for a call at module level. */
export function callerOf(project, call) {
  if (call.in === null) return null;
  const dot = call.in.indexOf('.');
  if (dot < 0) return project.files.get(call.file)?.functions.has(call.in) ? { id: functionSymbolId(call.file, call.in) } : null;
  const cls = project.files.get(call.file)?.classes.get(call.in.slice(0, dot));
  return cls ? { id: methodSymbolId(call.file, cls.name, call.in.slice(dot + 1)), cls } : null;
}

/** The class a field of `cls` is typed with, when the project has it. */
export function fieldClassOf(project, cls, name) {
  const hit = fieldOf(project, cls, name);
  return hit && hit.field.type ? project.classOf(hit.cls.file, hit.field.type) : null;
}

const methodTarget = (project, cls, name) => {
  const hit = cls ? methodOf(project, cls, name) : null;
  return hit ? methodSymbolId(hit.cls.file, hit.cls.name, name) : null;
};

/** What one call reaches, as `{to, rule}`, or null. */
function targetOf(project, call, caller) {
  const parts = call.callee.split('.');
  if (parts[0] === 'this' && parts.length === 2) {
    const to = methodTarget(project, caller.cls, parts[1]);
    return to && { to, rule: 'ts-this-method' };
  }
  if (parts[0] === 'this' && parts.length === 3 && caller.cls) {
    const to = methodTarget(project, fieldClassOf(project, caller.cls, parts[1]), parts[2]);
    return to && { to, rule: 'ts-injected-field' };
  }
  if (parts.length === 1) {
    const m = project.meaning(call.file, parts[0]);
    const fn = m && !m.external ? project.files.get(m.file)?.functions.get(m.name) : null;
    return fn ? { to: functionSymbolId(m.file, m.name), rule: 'ts-function' } : null;
  }
  if (parts.length === 2) {
    const to = methodTarget(project, project.classOf(call.file, parts[0]), parts[1]);
    return to && { to, rule: 'ts-static-method' };
  }
  return null;
}

const CALL_BASIS = Object.freeze({
  'ts-this-method': 'a method of the same class, or of a class it extends; a subclass may override it',
  'ts-injected-field': 'a method of the class a constructor-injected field is typed with; the provider may be another class of that type',
  'ts-function': 'a function the file declares or imports by name',
  'ts-static-method': 'a static method of a class the file names',
});

/**
 * Whether a call goes into a package: a function or a class the file imports
 * from one, or a method of a field typed with one. Its code is not read, so it
 * is no gap in this project's links.
 */
function intoPackage(project, call, caller) {
  const parts = call.callee.split('.');
  if (parts[0] !== 'this') return Boolean(project.meaning(call.file, parts[0])?.external);
  const hit = parts.length >= 3 && caller.cls ? fieldOf(project, caller.cls, parts[1]) : null;
  return Boolean(hit?.field.type && project.meaning(hit.cls.file, hit.field.type)?.external);
}

/**
 * Every call the project resolves, as MAY_CALL edges. The rest are counted:
 * `external` goes into a package, `unresolved` is a receiver this lane does not
 * type (a local variable, a parameter, a chain through a field).
 */
export function addCalls(g, project) {
  const stats = { resolved: 0, external: 0, unresolved: 0 };
  const seen = new Set();
  for (const call of project.calls) {
    const caller = callerOf(project, call);
    const target = caller ? targetOf(project, call, caller) : null;
    if (!target || !g.nodes.has(target.to)) {
      if (caller) stats[intoPackage(project, call, caller) ? 'external' : 'unresolved'] += 1;
      continue;
    }
    stats.resolved += 1;
    const key = `${caller.id}|${target.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    g.addEdge({ from: caller.id, to: target.to, type: 'MAY_CALL', grade: 'SOUND_SET', evidence: { rule: target.rule, basis: CALL_BASIS[target.rule], line: call.line } });
  }
  return stats;
}
