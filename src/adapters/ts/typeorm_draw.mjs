// typeorm_draw.mjs — one TypeORM statement drawn: its node, its caller's IMPLEMENTS_STMT, and the tables and columns its effects name.
//
// What an operation or a builder reads and writes is the rules' conclusion
// (src/core/rules/kinds/typeorm_operation.mjs, typeorm_query_builder.mjs), in
// property names or on entity views; here it lands on the catalog's nodes
// (typeorm_catalog.mjs) with the grades typeorm_reach.mjs caps them at. What a
// rule could not follow travels on the statement as `unresolved`, and what only
// the running program knows as `columnsRuntimeOnly`, as on a Prisma statement.

import { nodeId } from '../../core/graph.mjs';
import { statementEdges, readWholeRow, followPath, followEager, followRelation } from './typeorm_reach.mjs';

const ACCESS = Object.freeze({ select: 'read', insert: 'write', update: 'write', upsert: 'write', delete: 'delete' });
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export const bySite = (a, b) => cmp(a.call.file, b.call.file) || cmp(String(a.call.in), String(b.call.in)) || a.call.n - b.call.n || a.index - b.index;

/** The entity a site names: a class of the project the model maps, or an entity by its class or table name. */
export function entityOfRef(project, model, ref) {
  if (!ref) return null;
  if (ref.name) {
    const cls = project.classOf(ref.file, ref.name);
    return cls ? model.entities.get(cls.key) ?? null : null;
  }
  const hits = [...model.entities.values()].filter((e) => e.name === ref.entityName || e.table === ref.entityName);
  return hits.length === 1 ? hits[0] : null;
}

/** An entity as the operation rule reads one: its column properties, relations, key, delete date column and the columns TypeORM sets itself, by property. */
export function operationView(e) {
  const own = e.columns.filter((c) => !c.join);
  return {
    fields: own.map((c) => c.property), relations: e.relations.map((r) => r.property), pk: own.filter((c) => c.pk).map((c) => c.property), deleteDate: own.find((c) => c.deleteDate)?.property ?? null,
    auto: own.filter((c) => c.auto).map((c) => ({ property: c.property, role: c.role, sets: c.auto, insertable: c.insertable })),
  };
}

const AUTO_RULE = 'typeorm-auto-column';

/** The columns TypeORM set on its own in what an operation sent, each edge saying so. */
function drawAutoColumns(se, e, fx) {
  const at = (p) => ({ rule: AUTO_RULE, basis: fx.autoWhy.get(p) });
  for (const [set, type, grade] of [[fx.autoWrites, 'WRITES', 'EXACT'], [fx.mayAutoWrites, 'WRITES', 'SOUND_SET'], [fx.autoReads, 'READS', 'EXACT'], [fx.mayAutoReads, 'READS', 'SOUND_SET']]) {
    for (const p of set) se.column(e, propertyColumn(e, p), type, grade, at(p));
  }
}

const propertyColumn = (e, prop) => e.columns.find((c) => c.property === prop && !c.join) ?? null;

/**
 * The relations a find loads with its rows: those its options name, each
 * joined and selected whole (unless a select narrows it, which is not read),
 * with the eager relations of what each brings; and the entity's own eager
 * relations, whatever its select names, as SelectQueryBuilder joins them.
 */
function drawRelations(se, e, fx) {
  const grade = fx.optionsUnknown ? 'SOUND_SET' : 'EXACT';
  // TypeORM 0.2 joins a named relation's eager relations even with loadEagerRelations: false; 0.3 does not.
  const eager = fx.noEager ? 'SOUND_SET' : fx.eagerMay ? 'SOUND_SET' : grade;
  for (const path of fx.follows) {
    const narrowed = fx.hasSelect && fx.relations.has(path.split('.')[0]);
    followPath(se, e, path, { grade, whole: !narrowed, eager, rule: 'typeorm-relations-option' });
  }
  if (fx.eager) followEager(se, e, { grade: fx.eager === 'may' ? 'SOUND_SET' : 'EXACT', rule: 'typeorm-eager-relation' });
  if (fx.eagerJoined) followEager(se, e, { grade: 'SOUND_SET', joinOnly: true, rule: 'typeorm-eager-relation' });
}

/** What a Repository or EntityManager operation reads and writes, drawn. */
export function drawOperation(se, e, fx, op) {
  const may = 'SOUND_SET';
  se.table(e, ACCESS[fx.statement], 'EXACT');
  for (const p of fx.reads) se.column(e, propertyColumn(e, p), 'READS', 'EXACT');
  for (const p of fx.writes) se.column(e, propertyColumn(e, p), 'WRITES', 'EXACT');
  for (const p of fx.mayReads) se.column(e, propertyColumn(e, p), 'READS', may);
  for (const p of fx.mayWrites) se.column(e, propertyColumn(e, p), 'WRITES', may);
  const joinColumns = (r) => e.relations.find((x) => x.property === r)?.joinColumns ?? [];
  for (const [set, grade] of [[fx.writeRelations, 'EXACT'], [fx.mayWriteRelations, may]]) for (const r of set) for (const jc of joinColumns(r)) se.column(e, jc, 'WRITES', grade);
  drawAutoColumns(se, e, fx);
  if (fx.wholeRow) readWholeRow(se, e, fx.wholeRow === 'exact' ? 'EXACT' : may);
  drawRelations(se, e, fx);
  for (const r of [...fx.relations].sort()) se.unresolved.push({ reason: 'relation-not-followed', detail: `${e.name}.${r} reaches another table this statement does not name` });
  for (const k of [...fx.unknownKeys].sort()) se.unresolved.push({ reason: 'argument-not-read', detail: `${op}(${k})` });
}

/** The column a builder's hit names, on the entity of its view. */
const col = (h) => h.view.entity.columns.find((c) => c.column === h.column);

/** What a query builder reads and writes, drawn: every table its aliases name, and the columns of each. */
export function drawBuilder(se, fx, main) {
  const may = 'SOUND_SET';
  // A builder that escapes may be run with steps not read here: all it reads is a candidate.
  const run = fx.terminal && !fx.escaped ? 'EXACT' : may;
  if (main) se.table(main, ACCESS[fx.statement], run);
  for (const f of fx.follows) followRelation(se, f.view.entity, f.view.entity.relations.find((r) => r.property === f.property), { grade: f.may ? may : run, whole: false, rule: 'typeorm-join' });
  for (const t of fx.tables) se.table(t.view.entity, 'read', t.may ? may : run, { rule: 'typeorm-join' });
  for (const h of fx.reads) se.column(h.view.entity, col(h), 'READS', run);
  for (const h of fx.mayReads) se.column(h.view.entity, col(h), 'READS', may);
  for (const h of fx.writes) se.column(h.view.entity, col(h), 'WRITES', run);
  for (const h of fx.mayWrites) se.column(h.view.entity, col(h), 'WRITES', may);
  for (const w of fx.wholeRow) readWholeRow(se, w.view.entity, w.grade === 'exact' ? run : may);
  drawBuilderAuto(se, fx, run);
  builderGaps(se, fx);
}

/** The columns TypeORM set on its own in the statement a builder made, at the builder's grade or SOUND_SET when it may not. */
function drawBuilderAuto(se, fx, run) {
  for (const [list, type] of [[fx.autoWrites ?? [], 'WRITES'], [fx.autoReads ?? [], 'READS']]) {
    for (const h of list) se.column(h.view.entity, col(h), type, h.may ? 'SOUND_SET' : run, { rule: AUTO_RULE, basis: h.why });
  }
}

/** What a builder's statement could not read, said on it. */
function builderGaps(se, fx) {
  for (const n of fx.notRead) se.unresolved.push({ reason: 'builder-step-not-read', detail: n });
  if (fx.escaped) se.unresolved.push({ reason: 'builder-escapes', detail: `${fx.escaped}, where steps this engine does not read may change what it reads` });
  if (!fx.terminal) se.unresolved.push({ reason: 'builder-not-run-here', detail: 'no step that runs the query is written where the builder is made, so whether it runs, and what it returns, is not known here' });
}

function statementNode(sid, site, e, fx, se) {
  const runtime = [...(fx.runtimeOnly ?? [])].sort();
  const entity = e ? { entity: e.name, table: e.table } : {};
  return {
    id: sid, statementType: fx.statement, source: 'typeorm', file: site.call.file, line: site.line,
    typeormEvidence: { ...entity, operation: site.op, receiver: site.receiver.via, rule: fx.rule, ...(site.builder ? { builder: true } : {}) },
    ...(runtime.length > 0 ? { columnsRuntimeOnly: true, columnsRuntimeOnlyReason: `the ${runtime.join(', ')} of this call is only known when it runs` } : {}),
    ...(se.unresolved.length > 0 ? { hasUnresolved: true, unresolved: se.unresolved } : {}),
  };
}

/** One site's statement, drawn with its edges and its caller's IMPLEMENTS_STMT. */
export function writeStatement(g, a) {
  const { site, k, caller, e, fx, draw, env, stats } = a;
  const sid = nodeId('statement', `typeorm:${site.call.file}#${site.call.in}/${k}`);
  const se = statementEdges({ nodes: env.nodes, schemaName: env.schemaName, cap: 'EXACT', operation: site.op });
  draw(se);
  g.addNode(statementNode(sid, { ...site, builder: a.builder }, e, fx, se));
  g.addEdge({
    from: caller.id, to: sid, type: 'IMPLEMENTS_STMT', grade: 'EXACT',
    evidence: { rule: env.receiverRule, basis: `this method sends ${site.op}${e ? ` on ${e.name}` : ''} through a TypeORM ${site.receiver.kind} (${site.receiver.via})`, line: site.line },
  });
  se.flush(g, sid);
  stats.statements += 1;
  stats.byOperation[site.op] = (stats.byOperation[site.op] ?? 0) + 1;
}
