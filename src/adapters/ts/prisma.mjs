// prisma.mjs — the SQL a Prisma client call sends: one statement per call site, and the table and columns it touches.
//
// `this.prisma.marketData.findMany({ where: { symbol }, select: { date: true } })`
// in `MarketDataService.getRange` is a statement of its own:
// `statement:prisma:<file>#MarketDataService.getRange/0`, the first Prisma call
// of that method. It reads MarketData.symbol and MarketData.date. Another call
// on the same model with another select is another statement, so what one
// call reads never reaches the callers of the other.
//
// The receiver is a client when the field it is read from is typed with a type
// the `ts.type-role` rules name, or with a project class that extends one. The
// model is the one the delegate names in schema.prisma, and what the call reads
// and writes is the `prisma.operation` rule's reading of its argument. What the
// rule cannot follow (a relation, a spread) travels on the statement.

import { nodeId } from '../../core/graph.mjs';
import { tableKey, columnKey, graphSpellingIndex } from '../sql_bridge.mjs';
import { modelOfDelegate } from './prisma_schema.mjs';
import { callerOf } from './ts_calls.mjs';
import { fieldOf } from './project.mjs';

const ACCESS = Object.freeze({ select: 'read', insert: 'write', update: 'write', upsert: 'write', delete: 'delete' });
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
/** Calls in file, member and place order: the order the ordinals are counted in. */
const bySite = (a, b) => cmp(a.file, b.file) || cmp(String(a.in), String(b.in)) || a.n - b.n;

/** The client role a meaning plays under the rules, or null. */
function roleOfMeaning(rules, meaning) {
  const hit = rules.find((r) => r.compiled.means(meaning));
  return hit ? { grade: hit.compiled.grade, rule: hit.id, library: hit.compiled.library } : null;
}

/** The client role of a type named in `file`: the type itself, or a project class whose lineage extends one. */
function clientRoleOf(project, rules, file, typeName) {
  const meaning = project.meaning(file, typeName);
  if (!meaning) return null;
  if (meaning.external) return roleOfMeaning(rules, meaning);
  const cls = project.files.get(meaning.file)?.classes.get(meaning.name);
  for (const c of cls ? project.lineage(cls) : []) {
    const role = c.extends ? roleOfMeaning(rules, project.meaning(c.file, c.extends.split('.')[0])) : null;
    if (role) return role;
  }
  return null;
}

/** A call on a client's model delegate: `this.<field>.<delegate>.<operation>(...)` on a field of the caller's class. */
function clientCallOf(project, rules, call, caller) {
  const parts = call.callee.split('.');
  if (parts.length !== 4 || parts[0] !== 'this' || !caller?.cls) return null;
  const hit = fieldOf(project, caller.cls, parts[1]);
  const role = hit && hit.field.type ? clientRoleOf(project, rules, hit.cls.file, hit.field.type) : null;
  return role ? { role, delegate: parts[2], operation: parts[3] } : null;
}

function makeTableNodes(g, schemaName, identifierCase, stats) {
  const { settle, register } = graphSpellingIndex(g, identifierCase);
  const tableIdOf = (t) => settle(nodeId('table', tableKey(schemaName, t)));
  const columnIdOf = (t, c) => settle(nodeId('column', columnKey(schemaName, t, c)));
  const ensureTable = (model) => {
    const id = tableIdOf(model.table);
    if (!g.nodes.has(id)) { g.addNode({ id, stub: true, declaredBy: 'prisma', mappedFrom: model.name }); register(id); stats.tablesStubbed += 1; }
    return id;
  };
  const ensureColumn = (model, column) => {
    const cid = columnIdOf(model.table, column);
    if (!g.nodes.has(cid)) {
      g.addNode({ id: cid, name: column, stub: true, declaredBy: 'prisma' });
      g.addEdge({ from: ensureTable(model), to: cid, type: 'DECLARES', grade: 'EXACT' });
      register(cid);
      stats.columnsStubbed += 1;
    }
    return cid;
  };
  return { ensureTable, ensureColumn };
}

function statementNode(sid, call, cc, model, fx) {
  const unresolved = [
    ...[...fx.relations].sort().map((r) => ({ reason: 'relation-not-followed', detail: `${model.name}.${r} reaches another table this statement does not name` })),
    ...[...fx.unknownKeys].sort().map((k) => ({ reason: 'argument-not-read', detail: `${cc.operation}({ ${k} })` })),
  ];
  return {
    id: sid, statementType: fx.statement, source: 'prisma', file: call.file, line: call.line,
    prismaEvidence: { model: model.name, table: model.table, operation: cc.operation, receiver: call.callee, rule: fx.rule, client: cc.role.rule },
    ...(fx.runtimeOnly.size > 0 ? { columnsRuntimeOnly: true, columnsRuntimeOnlyReason: `the ${[...fx.runtimeOnly].sort().join(', ')} of this call is only known when it runs` } : {}),
    ...(unresolved.length > 0 ? { hasUnresolved: true, unresolved } : {}),
  };
}

function writeStatement(g, a) {
  const { sid, call, cc, model, fx, caller, tables } = a;
  g.addNode(statementNode(sid, call, cc, model, fx));
  const cap = cc.role.grade;
  g.addEdge({
    from: caller.id, to: sid, type: 'IMPLEMENTS_STMT', grade: cap,
    evidence: { rule: cc.role.rule, basis: `this method sends ${cc.operation} on ${model.name} through a Prisma client`, line: call.line, ...(cc.role.library ? { library: [cc.role.library] } : {}) },
  });
  g.addEdge({ from: sid, to: tables.ensureTable(model), type: 'EXECUTES', grade: cap, evidence: { access: ACCESS[fx.statement], via: 'prisma', operation: cc.operation } });
  const scalars = model.fields.filter((f) => !f.relation);
  const column = (name) => scalars.find((f) => f.name === name)?.column;
  const reads = new Set([...fx.reads].map(column).filter(Boolean));
  if (fx.wholeRow) for (const f of scalars) reads.add(f.column);
  const writes = new Set([...fx.writes].map(column).filter(Boolean));
  for (const [set, type] of [[reads, 'READS'], [writes, 'WRITES']]) {
    for (const c of [...set].sort()) g.addEdge({ from: sid, to: tables.ensureColumn(model, c), type, grade: cap, evidence: { via: 'prisma', operation: cc.operation } });
  }
}

/**
 * Every Prisma client call of the project as its own statement.
 *
 * @param {import('../../core/graph.mjs').Graph} g
 * @param {object} project  readProject's answer
 * @param {{schema:{models:Map}, clientRules:object[], operations:object, schemaName?:(string|null), identifierCase?:string}} opts
 */
export function addPrismaStatements(g, project, opts) {
  const stats = { statements: 0, clientCalls: 0, unknownModel: 0, unknownOperation: 0, tablesStubbed: 0, columnsStubbed: 0, byOperation: {} };
  const tables = makeTableNodes(g, opts.schemaName ?? null, opts.identifierCase ?? 'exact', stats);
  const ordinal = new Map();
  for (const call of [...project.calls].sort(bySite)) {
    const caller = callerOf(project, call);
    const cc = caller ? clientCallOf(project, opts.clientRules, call, caller) : null;
    if (!cc) continue;
    stats.clientCalls += 1;
    // The place among this method's client calls, whether or not this one is read.
    const k = ordinal.get(caller.id) ?? 0;
    ordinal.set(caller.id, k + 1);
    const model = modelOfDelegate(opts.schema.models, cc.delegate);
    if (!model) { stats.unknownModel += 1; continue; }
    const fx = opts.operations.effectsOf(cc.operation, call.args, model);
    if (!fx) { stats.unknownOperation += 1; continue; }
    const sid = nodeId('statement', `prisma:${call.file}#${call.in}/${k}`);
    writeStatement(g, { sid, call, cc, model, fx, caller, tables });
    stats.statements += 1;
    stats.byOperation[cc.operation] = (stats.byOperation[cc.operation] ?? 0) + 1;
  }
  return stats;
}
