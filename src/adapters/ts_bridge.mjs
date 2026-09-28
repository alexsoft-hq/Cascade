// ts_bridge.mjs — the TypeScript backend lane's bridge: tsfacts records to symbols, routes, calls and Prisma statements.
//
// The worker read each file alone (adapters/ts/tsfacts.mjs). Here the whole
// project is read at once (src/adapters/ts/project.mjs): which file an import
// names, which class a field is typed with, which controllers the application
// registers (src/adapters/ts/nest_routes.mjs), which calls reach which methods
// (src/adapters/ts/ts_calls.mjs), which tables and columns schema.prisma
// declares (src/adapters/ts/prisma_catalog.mjs) and the TypeORM entities map,
// and which Prisma and TypeORM calls send which SQL (src/adapters/ts/prisma.mjs,
// src/adapters/ts/typeorm.mjs). What the frameworks mean by their names is in
// the rule packs nestjs.json, prisma.json and typeorm.json, read through their
// kinds.
//
// An endpoint is keyed `endpoint:<VERB> <path>` like the Java lane's, so a
// frontend call the web lane reads meets it with no change there. An endpoint
// another lane already made keeps its fields; this lane only adds its handler.

import { nodeId } from '../core/graph.mjs';
import { groupOfPath } from '../core/walks.mjs';
import { builtinRegistry } from '../core/rules/registry.mjs';
import { readProject } from './ts/project.mjs';
import { nestRoutes } from './ts/nest_routes.mjs';
import { addCalls, addSymbols, methodSymbolId } from './ts/ts_calls.mjs';
import { addPrismaStatements } from './ts/prisma.mjs';
import { addPrismaCatalog } from './ts/prisma_catalog.mjs';
import { addTypeormStatements, typeormDiagnostics } from './ts/typeorm.mjs';

const HANDLES_BASIS = 'a controller the application registers declares this route in a decorator';

/**
 * The route as an endpoint, and its handler. A route whose address rests on an
 * exclude this engine could not read says so, at the grade that says it.
 *
 * `apiGroup` is the first segment of the route's own path, below the global
 * prefix, the version and the module path: `/api/v1/users/{id}` is `users`.
 * Those three are how the application is deployed, so grouping by the first
 * segment of the whole address put every route of a prefixed application in
 * one group. The core reads it wherever it groups routes (core/walks.mjs).
 */
function addRoute(g, r) {
  const epId = nodeId('endpoint', `${r.verb} ${r.path}`);
  const handler = methodSymbolId(r.file, r.cls, r.method);
  const existing = g.nodes.get(epId);
  if (!existing) {
    g.addNode({ id: epId, path: r.path, httpMethod: r.verb, handler, apiGroup: groupOfPath(r.ownPath), file: r.file, line: r.line ?? null, source: 'nestjs' });
  } else if (existing.handler && existing.handler !== handler) {
    existing.handlers = [...new Set([...(existing.handlers ?? [existing.handler]), handler])].sort();
  }
  g.addEdge({
    from: epId, to: handler, type: 'HANDLES', grade: r.grade ?? 'EXACT',
    evidence: { rule: r.rule, basis: r.uncertain ? `${HANDLES_BASIS}; ${r.uncertain}` : HANDLES_BASIS },
  });
}

/** Where schema.prisma and the SQL catalog this run read disagree, said once with its counts and a few of them. */
function catalogDiagnostic(catalog) {
  if (!catalog || !(catalog.disagreements > 0)) return [];
  const kinds = Object.entries(catalog.disagreementsByKind).sort().map(([k, n]) => `${n} ${k}`).join(', ');
  const said = (d) => `${d.what} ${d.column ?? d.table}${d.prisma === undefined ? '' : ` (schema.prisma ${d.prisma}, catalog ${d.catalog})`}`;
  return [{
    kind: 'PRISMA_CATALOG_DISAGREES',
    reason: `schema.prisma and the SQL catalog this run read disagree in ${catalog.disagreements} place(s) (${kinds}): ${catalog.disagreementSamples.slice(0, 5).map(said).join(', ')}. `
      + 'Neither is known to be the newer: a column they declare differently keeps both declarations on its node (declarationsDiffer), a table or column is the SQL catalog\'s node where it declares one, and a column only schema.prisma declares is added as its own; the whole list is on meta.laneStats.ts.prisma.catalog',
  }];
}

/** What the Prisma reading could not follow, said: calls that look like a client's and whose receiver is not one it knows, and a schema the SQL catalog disagrees with. */
function prismaDiagnostics(stats) {
  if (!stats) return [];
  const where = (stats.unreadSamples ?? []).map((c) => `${c.file}:${c.line} ${c.callee}${c.why ? ` (${c.why})` : ''}`).join(', ');
  const unread = stats.unreadClientCalls > 0
    ? [{ kind: 'TS_PRISMA_CALL_UNREAD', reason: `${stats.unreadClientCalls} call(s) name a model and an operation of the schema on a receiver not known to be a Prisma client, so no statement is made for them: ${where}` }]
    : [];
  return [...unread, ...catalogDiagnostic(stats.catalog)];
}

/** schema.prisma as the catalog, then every Prisma call as a statement against it; null with no schema, or no rule to read calls with. */
function prismaOf(g, project, rules, opts) {
  if (!opts.prisma || !rules.operations) return null;
  const catalog = addPrismaCatalog(g, opts.prisma.schema, {
    schemaName: opts.schemaName ?? null, identifierCase: opts.identifierCase ?? 'exact', catalogRecords: opts.catalogRecords ?? [],
  });
  const stats = addPrismaStatements(g, project, { schema: opts.prisma.schema, catalog, clientRules: rules.clients, operations: rules.operations });
  return { ...stats, catalog: catalog.stats };
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
  const typeorm = { entity: one('typeorm.entity'), receiver: one('typeorm.receiver'), operation: one('typeorm.operation'), builder: one('typeorm.query-builder') };
  return { routes: one('ts.route-decorator'), operations: one('prisma.operation'), clients: registry.ofKind('ts.type-role'), typeorm: Object.values(typeorm).every(Boolean) ? typeorm : null };
}

/** TypeORM's entities as a catalog, then every TypeORM call as a statement; null when the project has neither, or no rule to read them with. */
function typeormOf(g, project, rules, opts) {
  if (!rules.typeorm) return null;
  return addTypeormStatements(g, project, {
    ...rules.typeorm, schemaName: opts.schemaName ?? null, identifierCase: opts.identifierCase ?? 'exact', namingStrategy: opts.typeormNamingStrategy ?? null,
  });
}

/**
 * Add the TypeScript backend's facts to a graph.
 *
 * @param {import('../core/graph.mjs').Graph} g
 * @param {object[]} tsFacts  the tsfacts records of the application's files
 * @param {{tsconfig?:{baseUrl?:(string|null), paths?:object}, prisma?:({schema:{models:Map}}|null), globalPrefix?:(string|null), globalPrefixExclude?:(string[]|null),
 *          schemaName?:(string|null), identifierCase?:string, catalogRecords?:object[], typeormNamingStrategy?:(string|null), registry?:object}} [opts]
 *        `catalogRecords` are the SQL catalog's records this run read, if any, for schema.prisma to be read against;
 *        `typeormNamingStrategy` is the profile's declaration, which the TypeORM options are then not read for
 * @returns {object} stats, with every reason a route or a link was not made in `diagnostics`
 */
export function addTsFacts(g, tsFacts, opts = {}) {
  const rules = rulesOf(opts);
  const project = readProject(tsFacts, opts.tsconfig ?? {});
  const symbols = addSymbols(g, project);
  const routed = routesOf(project, rules, opts);
  for (const r of routed.routes) addRoute(g, r);
  const calls = addCalls(g, project);
  const [prisma, typeorm] = [prismaOf(g, project, rules, opts), typeormOf(g, project, rules, opts)];
  return {
    files: project.files.size, symbols, routes: routed.routes.length, heuristicRoutes: routed.routes.filter((r) => r.grade === 'HEURISTIC').length, controllers: routed.controllers,
    unregisteredControllers: routed.unregistered, calls, prisma, ...(typeorm ? { typeorm } : {}),
    diagnostics: [...routed.diagnostics, ...prismaDiagnostics(prisma), ...typeormDiagnostics(typeorm)],
  };
}
