// ts_bridge.mjs — the TypeScript backend lane's bridge: tsfacts records to symbols, routes, calls and Prisma statements.
//
// The worker read each file alone (adapters/ts/tsfacts.mjs). Here the whole
// project is read at once (src/adapters/ts/project.mjs): which file an import
// names, which class a field is typed with, which controllers the application
// registers (src/adapters/ts/nest_routes.mjs), which calls reach which methods
// (src/adapters/ts/ts_calls.mjs), and which Prisma calls send which SQL
// (src/adapters/ts/prisma.mjs). What the frameworks mean by their names is in
// the rule packs nestjs.json and prisma.json, read through their kinds.
//
// An endpoint is keyed `endpoint:<VERB> <path>` like the Java lane's, so a
// frontend call the web lane reads meets it with no change there. An endpoint
// another lane already made keeps its fields; this lane only adds its handler.

import { nodeId } from '../core/graph.mjs';
import { builtinRegistry } from '../core/rules/registry.mjs';
import { readProject } from './ts/project.mjs';
import { nestRoutes } from './ts/nest_routes.mjs';
import { addCalls, addSymbols, methodSymbolId } from './ts/ts_calls.mjs';
import { addPrismaStatements } from './ts/prisma.mjs';

const HANDLES_BASIS = 'a controller the application registers declares this route in a decorator';

/** The route as an endpoint, and its handler. A route whose address rests on an exclude this engine could not read says so, at the grade that says it. */
function addRoute(g, r) {
  const epId = nodeId('endpoint', `${r.verb} ${r.path}`);
  const handler = methodSymbolId(r.file, r.cls, r.method);
  const existing = g.nodes.get(epId);
  if (!existing) {
    g.addNode({ id: epId, path: r.path, httpMethod: r.verb, handler, file: r.file, line: r.line ?? null, source: 'nestjs' });
  } else if (existing.handler && existing.handler !== handler) {
    existing.handlers = [...new Set([...(existing.handlers ?? [existing.handler]), handler])].sort();
  }
  g.addEdge({
    from: epId, to: handler, type: 'HANDLES', grade: r.grade ?? 'EXACT',
    evidence: { rule: r.rule, basis: r.uncertain ? `${HANDLES_BASIS}; ${r.uncertain}` : HANDLES_BASIS },
  });
}

/** What the Prisma reading could not follow, said: calls that look like a client's and whose receiver is not one it knows. */
function prismaDiagnostics(stats) {
  if (!stats || !(stats.unreadClientCalls > 0)) return [];
  const where = (stats.unreadSamples ?? []).map((c) => `${c.file}:${c.line} ${c.callee}`).join(', ');
  return [{ kind: 'TS_PRISMA_CALL_UNREAD', reason: `${stats.unreadClientCalls} call(s) name a model and an operation of the schema on a receiver not known to be a Prisma client, so no statement is made for them: ${where}` }];
}

/** The routes, with what the profile declares for a bootstrap that reads its prefix and excludes from configuration. */
function routesOf(project, rules, opts) {
  if (!rules.routes) return { routes: [], diagnostics: [], controllers: 0, unregistered: null };
  return nestRoutes(project, rules.routes, { globalPrefix: opts.globalPrefix ?? null, globalPrefixExclude: opts.globalPrefixExclude ?? null });
}

/** The rules a run reads: the engine's own unless a caller hands others in (the tests do). */
function rulesOf(opts) {
  const registry = opts.registry ?? builtinRegistry();
  const one = (kind) => registry.ofKind(kind)[0]?.compiled ?? null;
  return { routes: one('ts.route-decorator'), operations: one('prisma.operation'), clients: registry.ofKind('ts.type-role') };
}

/**
 * Add the TypeScript backend's facts to a graph.
 *
 * @param {import('../core/graph.mjs').Graph} g
 * @param {object[]} tsFacts  the tsfacts records of the application's files
 * @param {{tsconfig?:{baseUrl?:(string|null), paths?:object}, prisma?:({schema:{models:Map}}|null), globalPrefix?:(string|null), globalPrefixExclude?:(string[]|null),
 *          schemaName?:(string|null), identifierCase?:string, registry?:object}} [opts]
 * @returns {object} stats, with every reason a route or a link was not made in `diagnostics`
 */
export function addTsFacts(g, tsFacts, opts = {}) {
  const rules = rulesOf(opts);
  const project = readProject(tsFacts, opts.tsconfig ?? {});
  const symbols = addSymbols(g, project);
  const routed = routesOf(project, rules, opts);
  for (const r of routed.routes) addRoute(g, r);
  const calls = addCalls(g, project);
  const prisma = opts.prisma && rules.operations
    ? addPrismaStatements(g, project, {
      schema: opts.prisma.schema, clientRules: rules.clients, operations: rules.operations,
      schemaName: opts.schemaName ?? null, identifierCase: opts.identifierCase ?? 'exact',
    })
    : null;
  return {
    files: project.files.size, symbols, routes: routed.routes.length, heuristicRoutes: routed.routes.filter((r) => r.grade === 'HEURISTIC').length, controllers: routed.controllers,
    unregisteredControllers: routed.unregistered, calls, prisma, diagnostics: [...routed.diagnostics, ...prismaDiagnostics(prisma)],
  };
}
