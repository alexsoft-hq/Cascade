// typeorm_operation_read.mjs — how one argument of a TypeORM Repository or EntityManager operation is read.
//
// Every argument plays one of a closed set of parts (the rule pack says which
// part each argument of each operation plays): find options, a where, ids, the
// criteria of an update or a delete, the values written, an entity, a property
// name, a conflict target. Each part is read here into property names of the
// entity: read, written, maybe read or written, relations the options load,
// relations this reading does not follow, keys it does not know, and what only
// the running program knows. Nothing is dropped silently.

export const ARG_ROLES = Object.freeze(['find-options', 'find-options-or-id', 'where', 'ids', 'criteria', 'values', 'entity', 'property', 'property-write', 'conflict', 'none']);
export const OPTION_ROLES = Object.freeze(['project', 'filter', 'read', 'relations', 'eager', 'not-read', 'none']);

const LITERAL = new Set(['str', 'num', 'bool', 'null', 'undefined']);
const RUNTIME = new Set(['id', 'member', 'call', 'expr', 'tpl', 'new', 'fn']);

export function emptyEffects(op, rule) {
  return {
    statement: op.statement, rule, reads: new Set(), writes: new Set(), mayReads: new Set(), mayWrites: new Set(),
    wholeRow: false, eager: false, follows: new Set(), relations: new Set(), writeRelations: new Set(), mayWriteRelations: new Set(),
    unknownKeys: new Set(), runtimeOnly: new Set(), hasSelect: false, optionsUnknown: false, noEager: false, eagerMay: false,
  };
}

/** A key of a where, a select or an order: a property it reads, a relation it reaches, or a key the entity does not have. */
function keyTo(entity, key, fx, set) {
  if (entity.fields.includes(key)) set.add(key);
  else if (entity.relations.includes(key)) fx.relations.add(key);
  else fx.unknownKeys.add(key);
}

export function readWhere(v, role, entity, fx) {
  if (!v || v.k === 'none' || v.k === 'undefined') return;
  if (v.k === 'arr') { for (const x of v.v) readWhere(x, role, entity, fx); if (v.spread) fx.runtimeOnly.add(role); return; }
  if (v.k !== 'obj') { fx.runtimeOnly.add(role); return; }
  if (v.spread || v.computed) fx.runtimeOnly.add(role);
  for (const key of Object.keys(v.v)) keyTo(entity, key, fx, fx.reads);
}

function readSelect(v, entity, fx) {
  fx.hasSelect = true;
  if (v.k === 'arr' && !v.spread && v.v.every((x) => x.k === 'str')) { for (const x of v.v) keyTo(entity, x.v, fx, fx.reads); return; }
  if (v.k !== 'obj' || v.spread || v.computed) { fx.runtimeOnly.add('select'); return; }
  for (const [key, x] of Object.entries(v.v)) {
    if (x.k === 'bool' && x.v === false) continue;
    if (entity.relations.includes(key)) { fx.relations.add(key); continue; }
    if (x.k === 'bool') keyTo(entity, key, fx, fx.reads);
    else { keyTo(entity, key, fx, fx.mayReads); fx.runtimeOnly.add(`select.${key}`); }
  }
}

function readOrder(v, entity, fx) {
  if (v.k !== 'obj' || v.spread || v.computed) { fx.runtimeOnly.add('order'); return; }
  for (const key of Object.keys(v.v)) keyTo(entity, key, fx, fx.reads);
}

/** `relations: ['articles', 'articles.comments']` or `{ articles: { comments: true } }`: the relation paths a find loads. */
function readRelations(v, entity, fx) {
  const add = (path) => (entity.relations.includes(path.split('.')[0]) ? fx.follows.add(path) : fx.unknownKeys.add(path));
  const walk = (obj, prefix) => {
    for (const [key, x] of Object.entries(obj.v)) {
      if (x.k === 'bool' && x.v === false) continue;
      if (x.k === 'obj' && !x.spread && !x.computed && Object.keys(x.v).length > 0) walk(x, `${prefix}${key}.`);
      else if (x.k === 'bool' || x.k === 'obj') add(`${prefix}${key}`);
      else fx.runtimeOnly.add('relations');
    }
  };
  if (v.k === 'arr' && !v.spread && v.v.every((x) => x.k === 'str')) for (const x of v.v) add(x.v);
  else if (v.k === 'obj' && !v.spread && !v.computed) walk(v, '');
  else fx.runtimeOnly.add('relations');
}

export function readFindOptions(v, entity, fx, roles) {
  if (!v || v.k === 'none' || v.k === 'undefined') return;
  if (v.k !== 'obj' || v.spread || v.computed) { fx.runtimeOnly.add('arguments'); fx.optionsUnknown = true; if (v.k !== 'obj') return; }
  for (const [key, x] of Object.entries(v.v)) {
    const role = roles[key];
    if (role === undefined || role === 'not-read') fx.unknownKeys.add(key);
    else if (role === 'project') readSelect(x, entity, fx);
    else if (role === 'filter') readWhere(x, 'where', entity, fx);
    else if (role === 'read') readOrder(x, entity, fx);
    else if (role === 'relations') readRelations(x, entity, fx);
    else if (role === 'eager') { if (x.k === 'bool') fx.noEager = x.v === false; else fx.eagerMay = true; }
  }
}

/**
 * TypeORM 0.2's test of find options against conditions
 * (FindOptionsUtils.isFindOneOptions): true, false, or null when a value's
 * kind is only known at run time. An object every key of which is a find
 * option and none a property of the entity can be nothing but options.
 */
export function looksLikeOptions(v, legacy, options, entity) {
  let unknown = false;
  for (const [key, x] of Object.entries(v.v)) {
    const kinds = legacy[key];
    if (!kinds) continue;
    if (kinds.includes(x.k)) return true;
    if (RUNTIME.has(x.k)) unknown = true;
  }
  const keys = Object.keys(v.v);
  if (unknown && keys.every((k) => Object.hasOwn(options, k) && !entity.fields.includes(k) && !entity.relations.includes(k))) return true;
  return unknown ? null : false;
}

const pkReads = (entity, fx) => { for (const p of entity.pk) fx.reads.add(p); };

/** Values not written out: every column, and the join column of every relation, MAY be written. */
function mayWriteAll(entity, fx, role) {
  for (const p of entity.fields) fx.mayWrites.add(p);
  for (const r of entity.relations) fx.mayWriteRelations.add(r);
  fx.runtimeOnly.add(role);
}

function readValues(v, entity, fx, role) {
  if (v && v.k === 'arr' && !v.spread) { for (const x of v.v) readValues(x, entity, fx, role); return; }
  if (!v || v.k !== 'obj') { mayWriteAll(entity, fx, role); return; }
  if (v.spread || v.computed) mayWriteAll(entity, fx, role);
  for (const key of Object.keys(v.v)) {
    if (entity.fields.includes(key)) fx.writes.add(key);
    else if (entity.relations.includes(key)) fx.writeRelations.add(key);
    else fx.unknownKeys.add(key);
  }
}

function readCriteria(v, entity, fx) {
  if (!v || v.k === 'none') return;
  if (LITERAL.has(v.k) || (v.k === 'arr' && v.v.every((x) => LITERAL.has(x.k)))) pkReads(entity, fx);
  else if (v.k === 'obj' || v.k === 'arr') readWhere(v, 'criteria', entity, fx);
  else fx.runtimeOnly.add('criteria');
}

function readProperty(v, entity, fx, write) {
  if (!v || v.k !== 'str') { fx.runtimeOnly.add('property'); return; }
  keyTo(entity, v.v, fx, fx.reads);
  if (write && entity.fields.includes(v.v)) fx.writes.add(v.v);
}

function readConflict(v, entity, fx) {
  const list = v && v.k === 'obj' && !v.spread ? v.v.conflictPaths : v;
  if (list && list.k === 'arr' && !list.spread && list.v.every((x) => x.k === 'str')) { for (const x of list.v) keyTo(entity, x.v, fx, fx.reads); return; }
  if (v && v.k !== 'none') fx.runtimeOnly.add('conflict');
}

/**
 * Find options, or, as TypeORM 0.2 also takes them, the conditions themselves
 * (and, where `idAllowed`, an id): told apart by the test the pack writes down.
 * An object that spreads another may be either, and is read as options, which
 * says what it cannot know.
 */
function readOptionsOrConditions(v, entity, fx, params, idAllowed) {
  if (!v || v.k === 'none' || v.k === 'undefined') return;
  if (LITERAL.has(v.k) && idAllowed) { pkReads(entity, fx); return; }
  const like = v.k === 'obj' ? (v.spread || v.computed ? true : looksLikeOptions(v, params.legacyFindOptions, params.findOptions, entity)) : null;
  if (like === true) readFindOptions(v, entity, fx, params.findOptions);
  else if (like === false) readWhere(v, 'where', entity, fx);
  else { fx.runtimeOnly.add('arguments'); fx.optionsUnknown = true; }
}

/** One argument, read by the part it plays. */
export function readArgument(role, v, entity, fx, params, op) {
  switch (role) {
    case 'find-options': readOptionsOrConditions(v, entity, fx, params, false); return;
    case 'find-options-or-id': readOptionsOrConditions(v, entity, fx, params, true); return;
    case 'where': readWhere(v, 'where', entity, fx); return;
    case 'ids': pkReads(entity, fx); return;
    case 'criteria': readCriteria(v, entity, fx); return;
    case 'values': readValues(v, entity, fx, 'values'); return;
    // save loads the row by its key before it writes what changed: the whole row MAY be read, which the operation's wholeRow says.
    case 'entity':
      if (op.writesEntity) readValues(v, entity, fx, 'entity'); else pkReads(entity, fx);
      return;
    case 'property': readProperty(v, entity, fx, false); return;
    case 'property-write': readProperty(v, entity, fx, true); return;
    case 'conflict': readConflict(v, entity, fx); return;
    case 'none': return;
    default: fx.unknownKeys.add(role);
  }
}
