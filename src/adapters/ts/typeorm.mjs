// typeorm.mjs — the SQL TypeORM sends: one statement per call site, the tables and columns it touches, and the entities as a catalog.
//
// `this.users.findOneBy({ email })` in `UsersService.byEmail` is a statement of
// its own: `statement:typeorm:<file>#UsersService.byEmail/0`, the first TypeORM
// operation of that method, numbered as the Prisma lane numbers its calls. A
// query builder is one statement too, at the call that makes it, with every
// step written on it (typeorm_builder.mjs).
//
// Which call is TypeORM's is the `typeorm.receiver` rule's reading; what an
// operation or a builder reads and writes, the `typeorm.operation` and
// `typeorm.query-builder` rules'; which tables and columns the entities map,
// and under which naming strategy, the `typeorm.entity` rule's
// (src/core/rules/packs/typeorm.json). A call that could not be read (an
// entity this engine does not know, an operation the pack does not name, raw
// SQL) draws nothing, and is counted, with a few named for a diagnostic.

import { callerOf } from './ts_calls.mjs';
import { catalogRecordsOf, catalogNodes, addRelationJoins } from './typeorm_catalog.mjs';
import { bySite, entityOfRef, operationView, drawOperation, drawBuilder, writeStatement } from './typeorm_draw.mjs';
import { builderSteps, builderContext } from './typeorm_builder.mjs';
import { entityRefOf } from '../../core/rules/kinds/typeorm_receiver_read.mjs';

const SAMPLES = 5;

function newStats() {
  return {
    entities: 0, tables: 0, columns: 0, joinTables: 0, joins: 0, heuristicNames: 0, tablesStubbed: 0, columnsStubbed: 0,
    naming: null, notRead: [], sites: 0, statements: 0, builders: 0, byOperation: {},
    raw: 0, unknownOperation: 0, unreadEntity: 0, outsideMember: 0, unreadSamples: [], untypedReceiver: 0, untypedSamples: [],
    reassignedReceiver: 0, reassignedSamples: [],
  };
}

const sample = (stats, site, why) => {
  stats.unreadSamples.push({ file: site.call.file, line: site.line, call: site.op, why });
};

/** A query builder's statement: its steps read by the builder rule, on the entity it was made on or the one a step names. */
function addBuilder(g, a) {
  const { project, model, site, opts, stats } = a;
  const e = entityOfRef(project, model, site.entity);
  const { viewOf, ctx, alias } = builderContext(project, model, site, entityOfRef);
  const held = builderSteps(project, site, opts.builder.roleOf);
  const fx = opts.builder.effectsOf({ view: e ? viewOf(e) : null, alias }, held.steps, ctx);
  if (held.unread) fx.notRead.push(held.unread);
  if (!fx.main) { stats.unreadEntity += 1; sample(stats, site, 'a query builder on no entity this engine read'); return; }
  const main = fx.main.entity;
  writeStatement(g, { ...a, e: main, fx, builder: true, draw: (se) => drawBuilder(se, fx, main) });
  stats.builders += 1;
}

/** One site: an operation or a builder drawn as a statement, or counted as not read. */
function addSite(g, a) {
  const { project, model, site, opts, stats, ordinal } = a;
  const kind = site.op === opts.builder.start ? 'builder' : opts.operation.kindOf(site.op);
  if (kind === 'no-sql') return;
  stats.sites += 1;
  const caller = callerOf(project, site.call);
  if (!caller) { stats.outsideMember += 1; return; }
  // The place among this method's TypeORM calls, whether or not this one is read, so reading more never renumbers.
  const k = ordinal.get(caller.id) ?? 0;
  ordinal.set(caller.id, k + 1);
  if (kind === 'raw') { stats.raw += 1; sample(stats, site, 'raw SQL, which this engine does not read'); return; }
  if (kind === null) { stats.unknownOperation += 1; sample(stats, site, 'an operation the typeorm pack does not name'); return; }
  if (kind === 'builder') { addBuilder(g, { ...a, caller, k }); return; }
  const e = entityOfRef(project, model, site.entity);
  if (!e) { stats.unreadEntity += 1; sample(stats, site, 'no entity this engine read is named'); return; }
  const fx = opts.operation.effectsOf(site.op, site.args.slice(site.argsFrom), operationView(e));
  writeStatement(g, { ...a, caller, k, e, fx, draw: (se) => drawOperation(se, e, fx, site.op) });
}

/**
 * A call that names an operation and, first, an entity of the project, on a
 * receiver the receiver rule could not type (`manager.find(User)` where
 * `manager` is a local this engine does not follow): no statement is made for
 * it, and this is the only place that says so.
 */
function countUntyped(project, model, opts, read, stats) {
  for (const call of project.calls) {
    if (read.has(call) || !call.callee.includes('.')) continue;
    const op = call.callee.slice(call.callee.lastIndexOf('.') + 1);
    if (opts.operation.kindOf(op) !== 'operation' || !entityOfRef(project, model, entityRefOf(call.file, call.args[0]))) continue;
    stats.untypedReceiver += 1;
    if (stats.untypedSamples.length < SAMPLES) stats.untypedSamples.push({ file: call.file, line: call.line, callee: call.callee });
  }
}

/**
 * What the lane line, the axes and the diagnostics say of the options: each
 * fact, where it came from, and `why`, the facts not known, in a sentence
 * (null when every fact is known).
 */
function namingSaid(n) {
  const declared = n.declared ?? [];
  const unknown = [
    ...(n.known ? [] : [`the naming strategy is not known (${n.reason})`]),
    ...(n.prefixKnown ? [] : [`the entityPrefix is not known (${n.prefixWhy})`]),
    ...(n.schemaKnown ? [] : [`the DataSource schema is not known (${n.schemaWhy})`]),
  ];
  return {
    strategy: n.strategy.name, known: n.known, from: declared.includes('namingStrategy') ? 'profile' : n.known ? 'options' : 'assumed', reason: n.reason,
    prefix: { value: n.prefix, known: n.prefixKnown, why: n.prefixWhy }, schema: { value: n.schema, known: n.schemaKnown, why: n.schemaWhy },
    declared, differs: n.differs ?? [], why: unknown.length > 0 ? unknown.join('; ') : null, sites: n.sites,
  };
}

/** The entities as a catalog in the graph, and what the lane line and the column axis say of them. */
function addCatalog(g, model, opts, stats) {
  const nodes = catalogNodes(g, opts.identifierCase ?? 'exact', stats);
  const records = catalogRecordsOf(model, opts.schemaName ?? null);
  for (const r of records) nodes.ensure(r);
  stats.joins = addRelationJoins(g, model, nodes, opts.schemaName ?? null);
  stats.entities = model.entities.size;
  stats.joinTables = model.junctions.length;
  stats.tables = records.filter((r) => r.kind === 'table').length;
  stats.columns = records.filter((r) => r.kind === 'column').length;
  stats.heuristicNames = records.filter((r) => r.grade !== 'EXACT').length;
  stats.naming = namingSaid(model.naming);
  stats.notRead = [...model.notRead, ...[...model.entities.values()].flatMap((e) => e.notRead.map((n) => ({ entity: e.name, file: e.file, ...n })))];
  return nodes;
}

/**
 * Every TypeORM call of the project as its own statement, over the entities
 * as a catalog. Null when the project has no entity and no TypeORM call, so a
 * project without TypeORM is left exactly as it was.
 *
 * @param {import('../../core/graph.mjs').Graph} g
 * @param {object} project  readProject's answer
 * @param {{entity:object, receiver:object, operation:object, builder:object, schemaName?:(string|null), identifierCase?:string, declared?:(object|null)}} opts
 *        the compiled typeorm rules, and what the profile's `tsBackend.typeorm` declares
 */
export function addTypeormStatements(g, project, opts) {
  const model = opts.entity.readModel(project, { declared: opts.declared ?? null });
  const { sites, unreadLocals } = opts.receiver.sitesOf(project);
  if (model.entities.size === 0 && sites.length === 0) return null;
  const stats = newStats();
  stats.reassignedReceiver = unreadLocals.length;
  stats.reassignedSamples = unreadLocals.slice(0, SAMPLES).map((c) => ({ file: c.file, line: c.line, callee: c.callee }));
  const nodes = addCatalog(g, model, opts, stats);
  const env = { nodes, schemaName: opts.schemaName ?? null, receiverRule: opts.receiver.rule };
  const ordinal = new Map();
  for (const site of [...sites].sort(bySite)) addSite(g, { project, model, site, opts, stats, ordinal, env });
  countUntyped(project, model, opts, new Set(sites.map((s) => s.call)), stats);
  stats.unreadSamples = stats.unreadSamples.sort((x, y) => (x.file < y.file ? -1 : x.file > y.file ? 1 : x.line - y.line)).slice(0, SAMPLES);
  stats.notRead = stats.notRead.slice(0, SAMPLES * 4);
  return stats;
}

/** Calls whose receiver this reading could not type: one on an untyped receiver, one on a local written again. */
function receiverDiagnostics(stats) {
  const where = (list) => list.map((s) => `${s.file}:${s.line} ${s.callee}`).join(', ');
  const out = [];
  if (stats.untypedReceiver > 0) {
    out.push({ kind: 'TS_TYPEORM_RECEIVER_UNREAD', reason: `${stats.untypedReceiver} call(s) name a TypeORM operation and an entity on a receiver not known to be a repository or an entity manager, so no statement is made for them: ${where(stats.untypedSamples)}` });
  }
  if (stats.reassignedReceiver > 0) {
    out.push({ kind: 'TS_TYPEORM_RECEIVER_UNREAD', reason: `${stats.reassignedReceiver} call(s) are on a local that held a TypeORM repository or entity manager and is assigned again, so what it holds at the call is not known and no statement is made for them: ${where(stats.reassignedSamples)}` });
  }
  return out;
}

/** What the TypeORM reading could not settle, said: an assumed naming strategy, calls not read, mapping not read. */
export function typeormDiagnostics(stats) {
  if (!stats) return [];
  const out = [];
  if (stats.naming?.differs.length > 0) {
    out.push({ kind: 'TS_TYPEORM_NAMING_DECLARED', reason: `the profile's tsBackend.typeorm declares ${stats.naming.differs.join('; ')}; the profile's is used` });
  }
  if (stats.entities > 0 && stats.naming.why) {
    out.push({ kind: 'TS_TYPEORM_NAMING_ASSUMED', reason: `${stats.heuristicNames} table and column name(s) of ${stats.entities} TypeORM entity(ies) are graded HEURISTIC, because ${stats.naming.why}. Declaring them in tsBackend.typeorm (namingStrategy, entityPrefix, schema) settles it` });
  }
  const unread = stats.raw + stats.unknownOperation + stats.unreadEntity;
  if (unread > 0) {
    const where = stats.unreadSamples.map((s) => `${s.file}:${s.line} ${s.call} (${s.why})`).join(', ');
    out.push({ kind: 'TS_TYPEORM_CALL_UNREAD', reason: `${unread} TypeORM call(s) make no statement: ${stats.raw} raw SQL, ${stats.unknownOperation} operation(s) the pack does not name, ${stats.unreadEntity} on no entity this engine read. For example ${where}` });
  }
  out.push(...receiverDiagnostics(stats));
  if (stats.notRead.length > 0) {
    out.push({ kind: 'TS_TYPEORM_MAPPING_UNREAD', reason: `part of the entity mapping is not read, and draws nothing: ${stats.notRead.map((n) => `${n.entity}${n.property ? `.${n.property}` : ''} (${n.reason})`).join(', ')}` });
  }
  return out;
}
