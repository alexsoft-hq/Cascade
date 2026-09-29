// ts_bridge.mjs — the TypeScript backend lane's bridge: tsfacts records to symbols, routes, calls and Prisma statements.
//
// The worker read each file alone (adapters/ts/tsfacts.mjs). Here the whole
// project is read at once (src/adapters/ts/project.mjs): which file an import
// names, which class a field is typed with, which controllers the application
// registers (src/adapters/ts/nest_routes.mjs), which calls reach which methods
// (src/adapters/ts/ts_calls.mjs), which classes a call through a type may run
// (src/adapters/ts/dispatch.mjs) and what the modules bind to it
// (src/adapters/ts/nest_providers.mjs), which tables and columns schema.prisma
// declares (src/adapters/ts/prisma_catalog.mjs) and the TypeORM entities map,
// and which Prisma and TypeORM calls send which SQL (src/adapters/ts/prisma.mjs,
// src/adapters/ts/typeorm.mjs). What the frameworks mean by their names is in
// the rule packs nestjs.json, prisma.json and typeorm.json, read through their
// kinds.
//
// The files are the application's and those its imports reach elsewhere in
// the analyzed root (a monorepo's shared library): the run decides which
// (src/core/incremental.mjs), and they are read here as one project.
//
// An endpoint is keyed `endpoint:<VERB> <path>` like the Java lane's, so a
// frontend call the web lane reads meets it with no change there. An endpoint
// another lane already made keeps its fields; this lane only adds its handler.

import { nodeId } from '../core/graph.mjs';
import { groupOfPath } from '../core/walks.mjs';
import { builtinRegistry } from '../core/rules/registry.mjs';
import { readProject } from './ts/project.mjs';
import { subtypeIndex } from './ts/dispatch.mjs';
import { providerBindings } from './ts/nest_providers.mjs';
import { nestRoutes } from './ts/nest_routes.mjs';
import { addCalls, addSymbols, methodSymbolId } from './ts/ts_calls.mjs';
import { addPrismaStatements } from './ts/prisma.mjs';
import { addPrismaCatalog } from './ts/prisma_catalog.mjs';
import { addTypeormStatements, typeormDiagnostics } from './ts/typeorm.mjs';

const HANDLES_BASIS = 'a controller the application registers declares this route in a decorator';

/**
 * The route as an endpoint, and its handler. A route whose address rests on an
 * exclude this engine could not read says so, at the grade that says it, and
 * names it as the ADDRESS's doubt (`address`): a call the web lane matches to
 * the route carries it on its own link, so every walk grades a caller alike.
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
  g.addEdge({ from: epId, to: handler, type: 'HANDLES', grade: r.grade ?? 'EXACT', evidence: handlesEvidence(r) });
}

/** What a route's HANDLES edge rests on, and its ADDRESS's doubt when the lane has one (core/walks.mjs routeAddressOf). */
function handlesEvidence(r) {
  if (!r.uncertain) return { rule: r.rule, basis: HANDLES_BASIS };
  return { rule: r.rule, basis: `${HANDLES_BASIS}; ${r.uncertain}`, address: { grade: r.grade, why: r.uncertain } };
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
  if (!rules.routes) return { routes: [], diagnostics: [], controllers: 0, unregistered: null, root: null };
  return nestRoutes(project, rules.routes, { globalPrefix: opts.globalPrefix ?? null, globalPrefixExclude: opts.globalPrefixExclude ?? null });
}

/** The rules a run reads: the engine's own unless a caller hands others in (the tests do). */
function rulesOf(opts) {
  const registry = opts.registry ?? builtinRegistry();
  const one = (kind) => registry.ofKind(kind)[0]?.compiled ?? null;
  const typeorm = { entity: one('typeorm.entity'), receiver: one('typeorm.receiver'), operation: one('typeorm.operation'), builder: one('typeorm.query-builder') };
  return {
    routes: one('ts.route-decorator'), providers: one('ts.provider-binding'), operations: one('prisma.operation'), clients: registry.ofKind('ts.type-role'),
    typeorm: Object.values(typeorm).every(Boolean) ? typeorm : null,
  };
}

/** TypeORM's entities as a catalog, then every TypeORM call as a statement; null when the project has neither, or no rule to read them with. */
function typeormOf(g, project, rules, opts) {
  if (!rules.typeorm) return null;
  return addTypeormStatements(g, project, {
    ...rules.typeorm, schemaName: opts.schemaName ?? null, identifierCase: opts.identifierCase ?? 'exact', declared: opts.typeorm ?? null,
  });
}

/**
 * The files read outside the application's root, which its imports reached,
 * and the question whether a file is one: absent when there are none, so a
 * project without a shared library records what it always did.
 */
function reachedOf(project, appRoot) {
  if (typeof appRoot !== 'string') return { outside: null, stats: {} };
  const inApp = (f) => appRoot === '' || appRoot === '.' || f === appRoot || f.startsWith(`${appRoot}/`);
  const reached = [...project.files.keys()].filter((f) => !inApp(f)).sort();
  return { outside: (f) => !inApp(f), stats: reached.length > 0 ? { reached } : {} };
}

/**
 * The calls between the project's methods, each through the classes its
 * receiver's type may be and what the application's modules bind to it, and
 * which files the application's imports reached outside its root.
 */
function callsOf(g, project, rules, routed, opts) {
  const subtypesOf = subtypeIndex(project);
  const bindings = providerBindings(project, rules, { root: routed.root, rootUnread: routed.rootUnread ?? false }, subtypesOf);
  const reached = reachedOf(project, opts.appRoot);
  const calls = addCalls(g, project, { subtypesOf, bindings, outside: reached.outside, published: opts.publishedOf ?? (() => null) });
  return { calls, reached: reached.stats, diagnostics: [...(bindings ? bindings.diagnostics() : []), ...dispatchDiagnostics(g, calls)] };
}

/** Calls through a type whose set may be short, said once: how many, and the reasons, most common first. */
function dispatchDiagnostics(g, calls) {
  if (!(calls.dispatchHeuristic > 0)) return [];
  const why = new Map();
  for (const e of g.edges) {
    const reason = e.type === 'MAY_CALL' ? e.evidence?.dispatch?.incomplete : null;
    if (reason) why.set(reason, (why.get(reason) ?? 0) + 1);
  }
  const top = [...why.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 3).map(([r, n]) => `${n} edge(s): ${r}`).join('; ');
  return [{ kind: 'TS_DISPATCH_INCOMPLETE', reason: `${calls.dispatchHeuristic} call(s) through a type classes of the project extend or implement reach a set that may be short, so their edges are graded HEURISTIC: ${top}` }];
}

/**
 * Add the TypeScript backend's facts to a graph.
 *
 * @param {import('../core/graph.mjs').Graph} g
 * @param {object[]} tsFacts  the tsfacts records of the files the run read
 * @param {{tsconfig?:{baseUrl?:(string|null), paths?:object}, prisma?:({schema:{models:Map}}|null), globalPrefix?:(string|null), globalPrefixExclude?:(string[]|null),
 *          schemaName?:(string|null), identifierCase?:string, catalogRecords?:object[], typeorm?:({namingStrategy?:(string|null), entityPrefix?:(string|null), schema?:(string|null)}|null),
 *          registry?:object, appRoot?:string, publishedOf?:Function}} [opts]
 *        `catalogRecords` are the SQL catalog's records this run read, if any, for schema.prisma to be read against;
 *        `typeorm` is the profile's `tsBackend.typeorm` block: each part it declares is used instead of what the DataSource options say;
 *        `appRoot`, root-relative, tells the application's files from those its imports reached;
 *        `publishedOf(file)` says why the package holding a file may be published, null when it is not
 * @returns {object} stats, with every reason a route or a link was not made in `diagnostics`
 */
export function addTsFacts(g, tsFacts, opts = {}) {
  const rules = rulesOf(opts);
  const { project, leftOut } = projectOf(tsFacts, opts);
  const symbols = addSymbols(g, project);
  const routed = routesOf(project, rules, opts);
  for (const r of routed.routes) addRoute(g, r);
  const linked = callsOf(g, project, rules, routed, opts);
  const [prisma, typeorm] = [prismaOf(g, project, rules, opts), typeormOf(g, project, rules, opts)];
  return {
    files: project.files.size, ...linked.reached, symbols, routes: routed.routes.length, heuristicRoutes: routed.routes.filter((r) => r.grade === 'HEURISTIC').length,
    controllers: routed.controllers, unregisteredControllers: routed.unregistered, calls: linked.calls, prisma, ...(typeorm ? { typeorm } : {}),
    diagnostics: [...leftOutDiagnostics(project, leftOut), ...routed.diagnostics, ...linked.diagnostics, ...prismaDiagnostics(prisma), ...typeormDiagnostics(typeorm)],
  };
}

/** The project the records describe, and the files the run found and did not read (its `leftOut` records), which are not packages. */
function projectOf(tsFacts, opts) {
  const leftOut = tsFacts.filter((r) => r?.kind === 'leftOut');
  const project = readProject(tsFacts.filter((r) => r?.kind !== 'leftOut'), opts.tsconfig ?? {}, { leftOut: new Set(leftOut.map((r) => r.file)) });
  return { project, leftOut };
}

/** Each file a read file imports or re-exports that the run did not read, as `importer -> file`. */
function importsOfLeftOut(project, files) {
  const out = [];
  for (const [file, f] of project.files) {
    for (const r of [...f.imports, ...f.exports]) {
      const target = r.source ? project.resolveModule(file, r.source) : null;
      if (target && files.has(target)) out.push(`${file} -> ${target}`);
    }
  }
  return [...new Set(out)].sort();
}

/**
 * The files the run found and did not read, said with how many and which: test
 * support no read file imports, and files whose bytes are outside the
 * analyzed root. Those a read file imports or re-exports come first: what they
 * declare (a controller a module registers, a class a call reaches) is not
 * known here.
 */
function leftOutDiagnostics(project, leftOut) {
  if (leftOut.length === 0) return [];
  const count = (why) => leftOut.filter((l) => l.why === why).length;
  const named = importsOfLeftOut(project, new Set(leftOut.map((l) => l.file)));
  const samples = named.length > 0 ? `; read files name ${named.length} of them: ${named.slice(0, 5).join(', ')}` : `, for example ${leftOut.slice(0, 3).map((l) => l.file).join(', ')}`;
  return [{
    kind: 'TS_FILES_LEFT_OUT',
    reason: `${leftOut.length} TypeScript file(s) found are not read: ${count('test-support')} test support (typescript.test-support) no read file imports, ${count('outside-root')} whose bytes are outside the analyzed root${samples}. What they declare is not in this pack`,
  }];
}

/**
 * The functions both this lane and another made (src/core/graph.mjs keeps them
 * one node with both lanes), said once the graph is whole: the web lane read
 * the requests such a function sends by the frontend's address rules, and a
 * walk from a backend route that goes through it takes those requests too.
 */
export function symbolsSharedWithOtherLanes(g) {
  const shared = [...g.nodes.values()].filter((n) => n.kind === 'symbol' && Array.isArray(n.lanes) && n.lanes.includes('ts')).map((n) => n.id).sort();
  if (shared.length === 0) return [];
  const samples = shared.slice(0, 5).map((id) => id.slice('symbol:'.length)).join(', ');
  return [{
    kind: 'TS_SYMBOL_SHARED_WITH_WEB',
    reason: `${shared.length} function(s) of a file the web lane reads as well are one node each, made by both lanes: ${samples}. `
      + 'The web lane addresses the requests they send by the frontend\'s rules, so a walk from a backend route through one of them takes those requests at the address the frontend would use',
  }];
}
