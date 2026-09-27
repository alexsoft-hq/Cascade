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
// model is the one the delegate names in schema.prisma, keyed under its own
// `@@schema` when it declares one, else the run's schemaName. What the call
// reads and writes is the `prisma.operation` rule's reading of its argument.
// What the rule cannot follow (a relation, a spread) travels on the statement;
// a field the rule can only say MAY be read (a dynamic `select` value) reads at
// SOUND_SET, never the client's own grade.
//
// An interactive transaction, `this.<field>.$transaction(async (tx) => {...})`,
// makes its callback's client parameter a client too: a call written through it
// inside those lines is read exactly as `this.<field>.<delegate>.<operation>`
// would be, still counted in the same method's statement sequence
// (src/core/rules/packs/prisma.json names the call and which parameter).
//
// A call shaped like a client's model.operation that this bridge could not type
// (a local variable holding the client, say) draws nothing, but is counted:
// `stats.unreadClientCalls` and a few samples, for a diagnostic to name.

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

/** The client role of a field of the caller's class, or null: `caller.cls` is required, as a client field is always read off `this`. */
function clientFieldRole(project, rules, caller, fieldName) {
  if (!caller?.cls) return null;
  const hit = fieldOf(project, caller.cls, fieldName);
  return hit && hit.field.type ? clientRoleOf(project, rules, hit.cls.file, hit.field.type) : null;
}

/**
 * A call on a client's model delegate: `this.<field>.<delegate>.<operation>(...)`
 * on a field of the caller's class, or, inside an interactive transaction's
 * callback, `<param>.<delegate>.<operation>(...)` where `<param>` is that
 * callback's client parameter (`bindings`, from transactionBindings below).
 */
function clientCallOf(project, rules, call, caller, bindings) {
  const parts = call.callee.split('.');
  if (parts.length === 4 && parts[0] === 'this') {
    const role = clientFieldRole(project, rules, caller, parts[1]);
    return role ? { role, delegate: parts[2], operation: parts[3], transaction: null } : null;
  }
  if (parts.length === 3) {
    const b = bindings.find((x) => x.file === call.file && x.member === call.in && x.param === parts[0] && call.line >= x.from && call.line <= x.to);
    if (b) return { role: b.role, delegate: parts[1], operation: parts[2], transaction: b.method };
  }
  return null;
}

/** A call `this.<field>.$transaction(fn, ...)`, `fn` the first function-valued argument, whose parameter at `clientParam` names a client too. */
function transactionBinding(project, rules, call, caller, txConfig) {
  const parts = call.callee.split('.');
  if (parts.length !== 3 || parts[0] !== 'this' || parts[2] !== txConfig.method) return null;
  const role = clientFieldRole(project, rules, caller, parts[1]);
  const fn = call.args.find((a) => a.k === 'fn');
  const param = fn ? fn.params[txConfig.clientParam] : null;
  if (!role || !fn || !param) return null;
  return { role, param, method: txConfig.method, file: call.file, member: call.in, from: fn.line, to: fn.endLine };
}

/** Every interactive-transaction callback whose client parameter is bound, across the project. */
function transactionBindings(project, rules, txConfig) {
  if (!txConfig) return [];
  const out = [];
  for (const call of project.calls) {
    const caller = callerOf(project, call);
    const b = caller ? transactionBinding(project, rules, call, caller, txConfig) : null;
    if (b) out.push(b);
  }
  return out;
}

function makeTableNodes(g, schemaName, identifierCase, stats) {
  const { settle, register } = graphSpellingIndex(g, identifierCase);
  const schemaOf = (model) => model.schema ?? schemaName;
  const tableIdOf = (model) => settle(nodeId('table', tableKey(schemaOf(model), model.table)));
  const columnIdOf = (model, c) => settle(nodeId('column', columnKey(schemaOf(model), model.table, c)));
  const ensureTable = (model) => {
    const id = tableIdOf(model);
    if (!g.nodes.has(id)) { g.addNode({ id, stub: true, declaredBy: 'prisma', mappedFrom: model.name }); register(id); stats.tablesStubbed += 1; }
    return id;
  };
  const ensureColumn = (model, column) => {
    const cid = columnIdOf(model, column);
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
    prismaEvidence: {
      model: model.name, table: model.table, operation: cc.operation, receiver: call.callee, rule: fx.rule, client: cc.role.rule,
      ...(cc.transaction ? { transaction: cc.transaction } : {}),
    },
    ...(fx.runtimeOnly.size > 0 ? { columnsRuntimeOnly: true, columnsRuntimeOnlyReason: `the ${[...fx.runtimeOnly].sort().join(', ')} of this call is only known when it runs` } : {}),
    ...(unresolved.length > 0 ? { hasUnresolved: true, unresolved } : {}),
  };
}

/** READS, WRITES, and the fields a dynamic projection may read: SOUND_SET, never the client's own grade, since which of them run is a run-time question. */
function writeColumnEdges(g, sid, cc, model, fx, cap, tables) {
  const scalars = model.fields.filter((f) => !f.relation);
  const column = (name) => scalars.find((f) => f.name === name)?.column;
  const reads = new Set([...fx.reads].map(column).filter(Boolean));
  if (fx.wholeRow) for (const f of scalars) reads.add(f.column);
  const writes = new Set([...fx.writes].map(column).filter(Boolean));
  const mayReads = new Set([...fx.mayReads].map(column).filter(Boolean));
  for (const [set, type, grade] of [[reads, 'READS', cap], [writes, 'WRITES', cap], [mayReads, 'READS', 'SOUND_SET']]) {
    for (const c of [...set].sort()) g.addEdge({ from: sid, to: tables.ensureColumn(model, c), type, grade, evidence: { via: 'prisma', operation: cc.operation } });
  }
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
  writeColumnEdges(g, sid, cc, model, fx, cap, tables);
}

/** One client call's statement, or nothing when its model or operation is not one the rule knows. */
function addOneStatement(g, a) {
  const { call, cc, caller, k, opts, tables, stats } = a;
  const model = modelOfDelegate(opts.schema.models, cc.delegate);
  if (!model) { stats.unknownModel += 1; return; }
  const fx = opts.operations.effectsOf(cc.operation, call.args, model);
  if (!fx) { stats.unknownOperation += 1; return; }
  const sid = nodeId('statement', `prisma:${call.file}#${call.in}/${k}`);
  writeStatement(g, { sid, call, cc, model, fx, caller, tables });
  stats.statements += 1;
  stats.byOperation[cc.operation] = (stats.byOperation[cc.operation] ?? 0) + 1;
}

/**
 * A call shaped like `<...>.<delegate>.<operation>(...)`, at least three parts,
 * naming a real model and an operation the rule knows, that this bridge never
 * read as a client call: nothing was drawn for it, and this is the only place
 * that says so.
 */
function addUnreadStats(project, opts, read, stats) {
  const known = new Set(opts.operations.operations);
  const samples = [];
  for (const call of project.calls) {
    if (read.has(call) || !callerOf(project, call)) continue;
    const parts = call.callee.split('.');
    if (parts.length < 3) continue;
    const [delegate, operation] = parts.slice(-2);
    if (!modelOfDelegate(opts.schema.models, delegate) || !known.has(operation)) continue;
    stats.unreadClientCalls += 1;
    samples.push({ file: call.file, line: call.line, callee: call.callee });
  }
  stats.unreadSamples = samples.sort((a, b) => cmp(a.file, b.file) || a.line - b.line).slice(0, 5);
}

/**
 * Every Prisma client call of the project as its own statement.
 *
 * @param {import('../../core/graph.mjs').Graph} g
 * @param {object} project  readProject's answer
 * @param {{schema:{models:Map}, clientRules:object[], operations:object, schemaName?:(string|null), identifierCase?:string}} opts
 */
export function addPrismaStatements(g, project, opts) {
  const stats = {
    statements: 0, clientCalls: 0, unknownModel: 0, unknownOperation: 0, tablesStubbed: 0, columnsStubbed: 0,
    byOperation: {}, unreadClientCalls: 0, unreadSamples: [],
  };
  const tables = makeTableNodes(g, opts.schemaName ?? null, opts.identifierCase ?? 'exact', stats);
  const bindings = transactionBindings(project, opts.clientRules, opts.operations.transaction);
  const ordinal = new Map();
  const read = new Set();
  for (const call of [...project.calls].sort(bySite)) {
    const caller = callerOf(project, call);
    const cc = caller ? clientCallOf(project, opts.clientRules, call, caller, bindings) : null;
    if (!cc) continue;
    read.add(call);
    stats.clientCalls += 1;
    // The place among this method's client calls, whether or not this one is read.
    const k = ordinal.get(caller.id) ?? 0;
    ordinal.set(caller.id, k + 1);
    addOneStatement(g, { call, cc, caller, k, opts, tables, stats });
  }
  addUnreadStats(project, opts, read, stats);
  return stats;
}
