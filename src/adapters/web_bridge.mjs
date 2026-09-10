// web_bridge.mjs — turn the web lane's facts (adapters/web/webfacts.mjs, schema
// cascade:webfacts:1) into `symbol --CALLS_HTTP--> endpoint` edges on a graph
// that already holds the routes this pack SERVES (SPEC §8, §9.1, the round trip
// of §1.1 seen from the other end).
//
// It MUTATES a graph the Java bridge has already built, because the question it
// answers is "which of THIS pack's endpoints does this frontend function call?"
// and the endpoints are what the Java bridge put there. Run the SQL bridge,
// then the Java bridge, then this.
//
// The chain it completes (forward; impactOf walks it backward):
//   webFunction --CALLS_HTTP--> endpoint --HANDLES--> handler --MAY_CALL--> …
//     … --IMPLEMENTS_STMT--> statement --WRITES/READS--> column
//
// GRADES — deliberately, honestly (HANDOFF §3):
//  - CALLS_HTTP  SOUND_SET   a platform sink (`fetch`, `XMLHttpRequest`) or an HTTP client
//                            library a declaration pack names, or a WRAPPER traced back to
//                            one, whose URL resolves to a literal or a template, matched to
//                            a route this pack serves.
//  - CALLS_HTTP  HEURISTIC   a URL-shaped argument handed to a call this lane could NOT
//                            trace to a sink, or a call whose prefix, alias or method had to
//                            be assumed. A rule guessed part of it, and the edge says which.
//  - CALLS_HTTP  UNRESOLVED  the URL resolved but no route here answers it, or it names
//                            another host. The edge is below every mode's floor, so no walk
//                            follows it, and the route it names is a node marked `outbound`
//                            exactly as the Java bridge marks a Feign call that leaves.
// A call whose URL never resolved at all (a parameter, an imported constant)
// gets NO edge, and is COUNTED by reason. Nothing is dropped in silence.
//
// WHAT IS NOT IN HERE, on purpose (SPEC §3.4, §6, §18.2): no project name and no
// wrapper name. Real frontends call their HTTP wrapper anything at all, so a
// rule written against one project's spelling is a rule that works on one
// project. The library vocabulary that DOES have fixed names (axios, ky,
// superagent, and which of their methods are verbs) lives in
// adapters/web/packs/http-clients.json, which is a declaration a reader can
// extend without touching this file.
//
// WHERE THE WORK IS. This file is the ORDER the steps run in and little else;
// each step lives in its own module under `src/adapters/web/`, and each of those
// opens by saying what it owns and what it must never know about:
//   symbols.mjs  the files, the names in them, and what each name IS
//   prefix.mjs   what a frontend's URL is missing, and how we know
//   calls.mjs    which route does this function ask the server for
//   screens.mjs  the screens a ROUTER declares, and what each one renders
//   pages.mjs    the screens the SERVER renders, and what a handler returned
//   stats.mjs    what the lane reports about its own run
//   shared.mjs   the string, path and URL primitives all six are written on
// Every export this file had before that split is still exported from here, so
// no importer and no test had to change. Nothing under `src/adapters/web/`
// imports this file back.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cmp, topCounts } from './web/shared.mjs';
import {
  collectInstances, indexWebFacts, isComponentFile, makeResolver, registryNameOf,
  webEndpointId, webScreenId, webSymbolId,
} from './web/symbols.mjs';
import {
  makePrefixes, prefixCensus, readPackages, WEB_PREFIX_BASIS,
} from './web/prefix.mjs';
import {
  buildRouteIndex, classifyCallSites, linkFrontendCalls, placeHttpEdges, routeMatches,
  traceWrappers, WEB_CALL_BASIS,
} from './web/calls.mjs';
import {
  buildRouterScreens, makeNameRegistry, placeRendersEdges, readRouteRecords, readScreenAxis,
  summariseScreens, SCREEN_RENDERS_BASIS, SCREEN_ROOT_GROUP, SCREEN_UNRESOLVED_SHARE,
} from './web/screens.mjs';
import { buildNexacroScreens, buildPageScreens, countTemplates, indexTemplates, PAGE_RENDERS_BASIS } from './web/pages.mjs';
import { emptyWebStats } from './web/stats.mjs';

export const WEBFACTS_SCHEMA = 'cascade:webfacts:1';

// The identity rules, the evidence sentences and the helpers other bridges read.
// Re-exported from where they live now, so `import { routeMatches } from
// './web_bridge.mjs'` still means exactly what it always meant.
export {
  isComponentFile, registryNameOf, routeMatches, webEndpointId, webScreenId, webSymbolId,
  PAGE_RENDERS_BASIS, SCREEN_RENDERS_BASIS, SCREEN_ROOT_GROUP, SCREEN_UNRESOLVED_SHARE,
  WEB_CALL_BASIS, WEB_PREFIX_BASIS,
};

/**
 * A URL path with one leading slash, no doubled slashes and no trailing slash.
 * Exported because the HAR bridge has to key a recorded path exactly the way
 * this bridge keyed the route it is matched against; two spellings of one path
 * would be two nodes.
 */
export { normalizeUrl as normalizeUrlPath } from './web/shared.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

let PACK_CACHE = null;
/**
 * The HTTP client declaration pack (SPEC §18.2). Read once per process: it is a
 * DECLARATION, so a new library is a row in that file and not a rule in here.
 * @returns {{platform:object[], libraries:object[]}}
 */
export function httpClientPack() {
  if (PACK_CACHE === null) {
    const file = path.join(HERE, '..', '..', 'adapters', 'web', 'packs', 'http-clients.json');
    PACK_CACHE = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  return PACK_CACHE;
}

/**
 * Add the web lane's CALLS_HTTP edges to a graph that already carries endpoints.
 *
 * @param {import('../core/graph.mjs').Graph} g
 * @param {object[]} webFacts  the whole cascade:webfacts:1 record stream
 * @param {{gatewayRoutes?:object, packages?:object[],
 *          screenAxis?:{enabled?:boolean, codeRegex?:string|null, pathRule?:string|null,
 *                       nameSource?:string}, codeLength?:number|null}} [opts]
 *        screenAxis is the profile's own block, read HERE and nowhere else
 *        (I-5); `enabled` is the gate, and with it false no screen is built.
 *        codeLength is `moduleAttribution.codeLength`, the number of leading
 *        characters of a screen code that name its group.
 * @returns {object} the lane statistics (§F of the round brief)
 */
export function addWebFacts(g, webFacts, opts = {}) {
  const records = Array.isArray(webFacts) ? webFacts : [];
  const gatewayRoutes = opts.gatewayRoutes && typeof opts.gatewayRoutes === 'object' ? opts.gatewayRoutes : {};
  const pack = httpClientPack();
  const libraries = new Map((pack.libraries ?? []).map((l) => [l.module, l]));
  // The clients a FRAMEWORK hands a function rather than a file importing them
  // (RM47). The worker decided which parameter really is one, by the pack's own
  // list and by where the function sits; here the name is looked up again for
  // the verb table and the default method.
  const injectedClients = new Map((pack.injected ?? []).map((c) => [c.name, c]));

  // B1: every fact bucketed by file and sorted inside its bucket.
  const { files, configs, parsed, fileNames } = indexWebFacts(records);
  // B1b: the server-rendered pages, BEFORE anything reads a call. It decides two
  // things the call pass needs: a page's URLs start at the application root, and
  // a template nobody renders is dead markup whose links are nobody's calls.
  const templates = indexTemplates({ fileNames, files, opts });
  // The packages, and what each one's .env / proxy / alias records declare.
  const { packageOf, configFor } = readPackages({ opts, configs });
  const stats = emptyWebStats();

  // B2 + B4: what a specifier leads to, and what a name holds.
  const resolver = makeResolver({ files, parsed, packageOf, configFor, libraries });
  const { instanceOf, noteInstance } = collectInstances({ fileNames, files, packageOf, resolver });

  // B4: the wrapper fixpoint, and with it what a callee resolves to.
  const { wrappers, calleeTarget, sinkVerb, platformOf } = traceWrappers({
    fileNames, files, libraries, pack, packageOf, resolver, stats,
  });
  stats.instances = instanceOf.size;

  // B6: the routes this pack SERVES, and B5: the prefix each client instance
  // sends its calls with. A prefix is asked for lazily, after the first pass
  // over the calls has said which URLs each instance sends.
  const { exactPaths, templatePaths, matchUrl } = buildRouteIndex(g);
  const callsPerInstance = new Map();
  const { prefixOf, gatewayKeys } = makePrefixes({
    instanceOf, configFor, gatewayRoutes, callsPerInstance, exactPaths, templatePaths, routeMatches,
  });

  // TWO PASSES over the calls, because the `auto` prefix has to count matches
  // over the calls of one instance before any of them can be graded.
  const sites = classifyCallSites({
    fileNames,
    files,
    packageOf,
    templatesByFile: templates.templatesByFile,
    contextVarsFor: templates.contextVarsFor,
    renderedTemplates: templates.renderedTemplates,
    instanceOf,
    callsPerInstance,
    stats,
    deps: {
      platformOf, injectedClients, calleeTarget, sinkVerb, wrappers, noteInstance,
      libraries, pack, stats, resolver,
    },
  });

  const nodesToAdd = new Map();
  const edges = [];
  const { httpFunctionIds, matchedRoutePaths, unmatched } = placeHttpEdges({
    sites, g, files, nodesToAdd, edges, stats, prefixOf, matchUrl, configFor, gatewayRoutes, gatewayKeys,
  });

  // =========================================================================
  // B7 — THE SCREEN AXIS (RM30)
  //
  // Everything above answers "which route does this function call?". Nothing
  // above says WHICH SCREEN that function belongs to, because the calls BETWEEN
  // frontend functions were not in the graph: a view that calls `listThings()`
  // from an api module had no path to the route at all. Three things close it:
  // the calls between frontend functions (B7a), the screens the router declares
  // (B7b), and the RENDERS edge from a screen to the functions of the component
  // it mounts (B7c).
  // =========================================================================
  const { symbolsByFile } = linkFrontendCalls({
    fileNames, files, resolver, sites, nodesToAdd, edges, stats, httpFunctionIds,
  });

  const axis = readScreenAxis({ opts, stats });
  const routeRecords = readRouteRecords({ fileNames, files, matchedRoutePaths, stats });
  const registry = makeNameRegistry({ fileNames, files });
  const { screenNodes, registryTargets, unresolvedSpecifiers } = buildRouterScreens({
    routeRecords, screenEnabled: axis.screenEnabled, axis, registry, resolver, stats,
  });

  // B7b': the pages a handler renders. The RENDERS_PAGE edges are held back so
  // they land in the same block as the RENDERS edges below.
  countTemplates({
    templatesByFile: templates.templatesByFile,
    includedBy: templates.includedBy,
    renderedTemplates: templates.renderedTemplates,
    stats,
  });
  const pageEdges = axis.screenEnabled
    ? buildPageScreens({
      g,
      viewRecords: templates.viewRecords,
      templatesByFile: templates.templatesByFile,
      templateByName: templates.templateByName,
      screenNodes,
      nodesToAdd,
      edges,
      stats,
      matchUrl,
      axis,
    })
    : [];
  // B7b'': the screens a Nexacro client declares (RM56) -- a form IS a screen.
  if (axis.screenEnabled) buildNexacroScreens({ templatesByFile: templates.templatesByFile, screenNodes, stats, axis });

  summariseScreens({
    stats, screenNodes, unresolvedSpecifiers, unresolvedNames: registry.unresolvedNames,
  });

  // B7c: RENDERS.
  for (const e of pageEdges) edges.push(e);
  placeRendersEdges({
    screenNodes,
    registryTargets,
    symbolsByFile,
    files,
    resolver,
    templatesByFile: templates.templatesByFile,
    includeClosure: templates.includeClosure,
    nodesToAdd,
    edges,
    stats,
  });

  // ---- write the graph, in a fixed order -----------------------------------
  for (const id of [...nodesToAdd.keys()].sort()) g.addNode(nodesToAdd.get(id));
  edges.sort((a, b) => cmp(a.from, b.from) || cmp(a.to, b.to) || cmp(JSON.stringify(a.evidence), JSON.stringify(b.evidence)));
  for (const e of edges) g.addEdge(e);

  // ---- what the run saw, and what it did not ------------------------------
  prefixCensus({ instanceOf, prefixOf, stats });
  stats.instances = [...instanceOf.values()].filter((i) => !i.id.endsWith('#(package)')).length;
  for (const site of sites) if (site.assumed) stats.assumedAliases += 1;
  stats.unmatchedUrls = topCounts(unmatched, 15, 'url');
  return stats;
}

export class WebBridgeError extends Error {
  constructor(message) { super(message); this.name = 'WebBridgeError'; }
}
