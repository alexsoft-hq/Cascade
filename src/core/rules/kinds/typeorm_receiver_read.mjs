// typeorm_receiver_read.mjs — which TypeORM object a call is made on, and which call on it is the operation.
//
// A call is read left to right, the way it runs: `this.dataSource` is a
// DataSource (the field's type says so), `.getRepository(Order)` on it is the
// repository of Order, `.find()` on that is the operation. The chain the
// worker recorded after a call (`getRepository(Tag).createQueryBuilder('t')
// .getMany()`) is read on, so an operation written on another call's result is
// found where it is written; what comes after the operation is its `rest`.
//
// Three names are bound as the method runs: a transaction callback's parameter
// is a manager, and a name that holds a repository or a manager
// (`const repo = this.ds.getRepository(User)`) is one from the line it is
// written on. A name this reading cannot type is not guessed at: the call is
// not TypeORM's as far as this engine can tell.

import { externalOf, isOneOf } from './ts_names.mjs';

/** A call's parts in order: every name of its receiver chain, then every chained call, each with its arguments when it is called. */
export function segmentsOf(call) {
  const segs = [];
  const push = (path, args, line) => {
    const ps = path.split('.');
    ps.forEach((name, i) => segs.push({ name, args: i === ps.length - 1 ? args : null, line }));
  };
  push(call.callee, call.args, call.line);
  for (const st of call.chain ?? []) push(st.name, st.args, st.line);
  return segs;
}

/** Where an entity is named: a class written in `file`, or an entity by its name as a string; null for anything else. */
export function entityRefOf(file, arg) {
  if (!arg) return null;
  if (arg.k === 'id') return { file, name: arg.v };
  if (arg.k === 'str') return { entityName: arg.v };
  return null;
}

/** The repository a class of the project is: one that extends Repository<Entity>, or one a custom-repository decorator names the entity of. */
export function customRepository(project, cls, cfg) {
  for (const k of project.lineage(cls)) {
    const dec = k.decorators.find((d) => isOneOf(externalOf(project, k.file, d.name), cfg.entityRepository));
    if (dec) return { kind: 'repository', entity: entityRefOf(k.file, dec.args[0]), via: `${cls.name}, a custom repository`, custom: cls };
    if (k.extends && isOneOf(externalOf(project, k.file, k.extends), cfg.types.repository)) {
      const arg = k.extendsArgs?.[0];
      return { kind: 'repository', entity: arg ? { file: k.file, name: arg } : null, via: `${cls.name}, which extends ${k.extends}`, custom: cls };
    }
  }
  return null;
}

const KINDS = Object.freeze(['repository', 'manager', 'data-source']);

/** What an injection decorator or a type makes a field: a repository of an entity, a manager, a data source, or null. */
function fieldValue(project, cls, name, cfg) {
  for (const c of project.lineage(cls)) {
    const field = c.fields.get(name);
    if (!field) continue;
    for (const d of field.decorators ?? []) {
      const ext = externalOf(project, c.file, d.name);
      const kind = KINDS.find((k) => isOneOf(ext, cfg.inject[k]));
      if (kind) return { kind, entity: kind === 'repository' ? entityRefOf(c.file, d.args[0]) : null, via: `@${d.name} on ${c.name}.${name}` };
    }
    if (!field.type) return null;
    const ext = externalOf(project, c.file, field.type);
    const kind = KINDS.find((k) => isOneOf(ext, cfg.types[k]));
    if (kind) {
      const arg = field.typeArgs?.[0];
      return { kind, entity: kind === 'repository' && arg ? { file: c.file, name: arg } : null, via: `${c.name}.${name}: ${field.type}` };
    }
    const typed = project.classOf(c.file, field.type);
    return typed ? customRepository(project, typed, cfg) : null;
  }
  return null;
}

/** Whether the project's own class declares a method, so a call of that name runs the project's code and not TypeORM's. */
const declares = (project, cls, method) => project.lineage(cls).some((c) => c.methods.has(method));

/** The value a call starts from, and the part after it. */
function startOf(project, call, cls, segs, bindings, cfg) {
  const [first, second] = segs;
  if (first.name === 'this' && cls && second) {
    if (second.args === null) return { value: fieldValue(project, cls, second.name, cfg), next: 2 };
    const self = customRepository(project, cls, cfg);
    return { value: self && !declares(project, cls, second.name) ? self : null, next: 1 };
  }
  if (first.args !== null) {
    const ext = externalOf(project, call.file, first.name);
    const kind = KINDS.find((k) => isOneOf(ext, cfg.functions[k]));
    return { value: kind ? { kind, entity: kind === 'repository' ? entityRefOf(call.file, first.args[0]) : null, via: `${first.name}()` } : null, next: 1 };
  }
  const b = bindings.find((x) => x.file === call.file && x.member === call.in && x.name === first.name && call.line >= x.from && call.line <= x.to);
  return { value: b ? b.value : null, next: 1 };
}

/** One part applied to the value so far: a new value, the operation, a transaction, or null when this reading cannot follow it. */
function step(value, seg, file, cfg) {
  const member = cfg.members[seg.name];
  if (seg.args === null) return member === 'manager' && value.kind !== 'manager' ? { value: { kind: 'manager', via: `${value.via}.manager` } } : null;
  if (member === 'repository' && value.kind !== 'repository') return { value: { kind: 'repository', entity: entityRefOf(file, seg.args[0]), via: `${value.via}.${seg.name}()` } };
  if (seg.name === cfg.transaction && value.kind !== 'repository') return { transaction: seg };
  return { op: seg };
}

/**
 * A call read through: `{op, value, args, index, rest}` for an operation,
 * `{value}` when it ends in a TypeORM object without calling one, `{transaction}`
 * for a transaction, or null.
 */
export function readCall(project, call, cls, bindings, cfg) {
  const segs = segmentsOf(call);
  const start = startOf(project, call, cls, segs, bindings, cfg);
  let value = start.value;
  if (!value) return null;
  for (let i = start.next; i < segs.length; i += 1) {
    const s = step(value, segs[i], call.file, cfg);
    if (!s) return null;
    if (s.transaction) return { transaction: s.transaction, value };
    if (s.op) {
      if (value.custom && declares(project, value.custom, segs[i].name)) return null;
      return { op: segs[i].name, value, args: segs[i].args, index: i, line: segs[i].line, rest: segs.slice(i + 1), segs };
    }
    value = s.value;
  }
  return { value, segs };
}
