// prisma.mjs — the SQL a Prisma client call sends: one statement per call site, and the tables and columns it touches.
//
// `this.prisma.marketData.findMany({ where: { symbol }, select: { date: true } })`
// in `MarketDataService.getRange` is a statement of its own:
// `statement:prisma:<file>#MarketDataService.getRange/0`, the first Prisma call
// of that method. It reads MarketData.symbol and MarketData.date. Another call
// on the same model with another select is another statement, so what one
// call reads never reaches the callers of the other.
//
// Which receivers are clients is prisma_clients.mjs's reading: a client field,
// a transaction callback's parameter, a client `$extends` made. The model is
// the one the delegate names in schema.prisma, its table and columns the ones
// schema.prisma's catalog put in the graph (prisma_catalog.mjs). What the call
// reads and writes is the `prisma.operation` rule's reading of its argument,
// with every relation it follows into the model that relation reaches, as part
// of this same statement (prisma_reach.mjs says why). What the rule cannot
// follow (a spread, a key it does not know) travels on the statement; a field
// the rule can only say MAY be read reads at SOUND_SET, never the client's own
// grade.
//
// An interactive transaction's calls are still counted in the method that
// makes them. A call shaped like a client's model.operation that this bridge
// could not type (a local variable holding the client, say) draws nothing, but
// is counted: `stats.unreadClientCalls` and a few samples, for a diagnostic to
// name, each with why when the reader knows (a local that held a client and is
// assigned again).
//
// A client an extension with a result component made computes fields no table
// has: selecting one reads the fields it `needs` (prisma_clients.mjs reads
// them), and is never a column of its own.

import { nodeId } from '../../core/graph.mjs';
import { modelOfDelegate } from './prisma_schema.mjs';
import { callerOf } from './ts_calls.mjs';
import { clientReader } from './prisma_clients.mjs';
import { statementEdges } from './prisma_reach.mjs';

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
/** Calls in file, member and place order: the order the ordinals are counted in. */
const bySite = (a, b) => cmp(a.file, b.file) || cmp(String(a.in), String(b.in)) || a.n - b.n;

/** How the call reached its client, on the statement: a transaction's callback, or a local holding a client `$extends` made. */
function clientEvidence(cc) {
  return {
    ...(cc.transaction ? { transaction: cc.transaction } : {}),
    ...(cc.extension ? { extension: cc.extension } : {}),
    ...(cc.returnedBy ? { returnedBy: cc.returnedBy } : {}),
  };
}

function statementNode(sid, call, cc, model, fx, relationGaps) {
  const unresolved = [
    ...relationGaps,
    ...[...fx.unknownKeys].sort().map((k) => ({ reason: 'argument-not-read', detail: `${cc.operation}({ ${k} })` })),
  ];
  return {
    id: sid, statementType: fx.statement, source: 'prisma', file: call.file, line: call.line,
    prismaEvidence: { model: model.name, table: model.table, operation: cc.operation, receiver: call.callee, rule: fx.rule, client: cc.role.rule, ...clientEvidence(cc) },
    ...(fx.runtimeOnly.size > 0 ? { columnsRuntimeOnly: true, columnsRuntimeOnlyReason: `the ${[...fx.runtimeOnly].sort().join(', ')} of this call is only known when it runs` } : {}),
    ...(unresolved.length > 0 ? { hasUnresolved: true, unresolved } : {}),
  };
}

/** Why the method's link to its statement is as sure as it is: the client rule, and the extension when one decides it. */
function implementsBasis(cc, model) {
  const base = `this method sends ${cc.operation} on ${model.name} through a Prisma client`;
  if (!cc.extension) return base;
  return cc.grade === cc.role.grade
    ? `${base} that ${cc.extension.method} made with an extension that rewrites no query`
    : `${base} that ${cc.extension.method} made with an extension this engine does not read whole, or one with a query component, which may change what the call sends`;
}

function writeStatement(g, a) {
  const { sid, call, cc, model, fx, caller, catalog } = a;
  const gaps = statementEdges(g, sid, { fx, model, grade: cc.grade, operation: cc.operation, catalog });
  g.addNode(statementNode(sid, call, cc, model, fx, gaps));
  g.addEdge({
    from: caller.id, to: sid, type: 'IMPLEMENTS_STMT', grade: cc.grade,
    evidence: { rule: cc.role.rule, basis: implementsBasis(cc, model), line: call.line, ...(cc.role.library ? { library: [cc.role.library] } : {}) },
  });
}

/**
 * The fields a client's extension computes, by model name: the ones it names
 * for every model, and over them the ones it names under that model's
 * delegate. Null when it computes none.
 */
function computedByModel(computed, models) {
  if (!computed) return null;
  const out = new Map();
  for (const m of models.values()) out.set(m.name, { ...computed.all });
  for (const [key, fields] of Object.entries(computed.byModel)) {
    const m = modelOfDelegate(models, key);
    if (m) Object.assign(out.get(m.name), fields);
  }
  return out;
}

/** One client call's statement, or nothing when its model or operation is not one the rule knows. */
function addOneStatement(g, a) {
  const { call, cc, caller, k, opts, stats } = a;
  const model = modelOfDelegate(opts.schema.models, cc.delegate);
  if (!model) { stats.unknownModel += 1; return; }
  const fx = opts.operations.effectsOf(cc.operation, call.args, model, opts.schema.models, computedByModel(cc.computed, opts.schema.models));
  if (!fx) { stats.unknownOperation += 1; return; }
  const sid = nodeId('statement', `prisma:${call.file}#${call.in}/${k}`);
  writeStatement(g, { sid, call, cc, model, fx, caller, catalog: opts.catalog });
  stats.statements += 1;
  stats.byOperation[cc.operation] = (stats.byOperation[cc.operation] ?? 0) + 1;
  if (fx.follow.length > 0) stats.followingRelations += 1;
  if (cc.extension) stats.throughExtension += 1;
}

/** One unread call as a sample: where it is, and why when the reader knows. */
const unreadSample = (call, why) => ({ file: call.file, line: call.line, callee: call.callee, ...(why ? { why } : {}) });

/**
 * A call shaped like `<...>.<delegate>.<operation>(...)`, at least three parts,
 * naming a real model and an operation the rule knows, that this bridge never
 * read as a client call: nothing was drawn for it, and this is the only place
 * that says so.
 */
function addUnreadStats(project, opts, read, stats, whyNot) {
  const known = new Set(opts.operations.operations);
  const samples = [];
  for (const call of project.calls) {
    if (read.has(call) || !callerOf(project, call)) continue;
    const parts = call.callee.split('.');
    if (parts.length < 3) continue;
    const [delegate, operation] = parts.slice(-2);
    if (!modelOfDelegate(opts.schema.models, delegate) || !known.has(operation)) continue;
    stats.unreadClientCalls += 1;
    samples.push(unreadSample(call, whyNot(call)));
  }
  stats.unreadSamples = samples.sort((a, b) => cmp(a.file, b.file) || a.line - b.line).slice(0, 5);
}

/**
 * Every Prisma client call of the project as its own statement.
 *
 * @param {import('../../core/graph.mjs').Graph} g
 * @param {object} project  readProject's answer
 * @param {{schema:{models:Map}, catalog:object, clientRules:object[], operations:object}} opts
 *        `catalog` is addPrismaCatalog's answer for the same schema
 */
export function addPrismaStatements(g, project, opts) {
  const stats = {
    statements: 0, clientCalls: 0, unknownModel: 0, unknownOperation: 0, followingRelations: 0, throughExtension: 0,
    byOperation: {}, unreadClientCalls: 0, unreadSamples: [],
  };
  const clientOf = clientReader(project, { clientRules: opts.clientRules, transaction: opts.operations.transaction, extensions: opts.operations.extensions });
  const ordinal = new Map();
  const read = new Set();
  for (const call of [...project.calls].sort(bySite)) {
    const caller = callerOf(project, call);
    const cc = caller ? clientOf(call, caller) : null;
    if (!cc) continue;
    read.add(call);
    stats.clientCalls += 1;
    // The place among this method's client calls, whether or not this one is read.
    const k = ordinal.get(caller.id) ?? 0;
    ordinal.set(caller.id, k + 1);
    addOneStatement(g, { call, cc, caller, k, opts, stats });
  }
  addUnreadStats(project, opts, read, stats, clientOf.whyNot);
  return stats;
}
