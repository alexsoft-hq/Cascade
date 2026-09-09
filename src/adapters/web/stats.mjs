// stats.mjs — what the web lane REPORTS about its own run.
//
// WHAT THIS MODULE OWNS: the shape of the statistics object, every counter in
// it, and the comment beside each counter saying why that number is worth
// having. `cascade analyze` prints these lines, `pack.meta.laneStats.web`
// carries them, and `src/core/lanes.mjs` decides from them whether the web and
// screen axes are shipped, degraded or absent. So this is the lane's own
// account of what it could and could not see, and every field here is a
// promise to a reader.
//
// WHAT IT MUST NEVER KNOW ABOUT: the graph, the fact stream, and the other
// modules in this directory. It builds an object of zeroes and hands it over;
// the steps fill it in as they go.

import { SERVER_MENU_ROUTE_CEILING } from './screens.mjs';

/**
 * A fresh statistics object, every counter at zero.
 *
 * It is one literal rather than six, because the caller returns it whole and a
 * field that exists only after some step ran would read as "we did not look"
 * where the truth is "there were none".
 */
export function emptyWebStats() {
  return {
    instances: 0,
    wrappers: { count: 0, maxDepth: 0, byKind: { function: 0, classMethod: 0 } },
    // `notUrlShaped` is the fifth number the round's shape did not ask for and
    // the lane cannot honestly leave out: a call the worker recorded as
    // carrying a URL, that reached no client and whose argument is not written
    // like a path. Counted here so it is never a silent drop.
    calls: {
      withUrl: 0, traced: 0, platform: 0, injected: 0, untraced: 0, notUrlShaped: 0,
      // A form or a link in a server-rendered page (RM48).
      template: 0,
      // A call onto an imported name that is not a function this lane read: a
      // constant, a component, a client instance. No CALLS edge, and counted so
      // the missing hop is a number rather than a silence.
      notAFunction: 0,
      // A function handed to a call as a VALUE that resolved to a function this
      // lane read (RM32). Counted per REFERENCE, which is not the number of
      // edges: two references from one function to the same target are one
      // edge, a pair that is also CALLED keeps the call's edge, and an edge
      // whose ends never reach HTTP is left out by the rule below. Read it
      // beside `callsByRule['passed-as-value']`, which counts what was placed.
      passedAsValue: 0,
    },
    resolved: { SOUND_SET: 0, HEURISTIC: 0 },
    unresolved: {
      total: 0,
      // `allHoles` is the sixth reason the round's shape did not ask for and the
      // lane cannot honestly leave out: a URL that resolved to nothing but
      // interpolations. It is not `noMatch` (it matches far too much) and not
      // `expression` (the worker did resolve it), so it is counted as itself.
      byReason: {
        parameter: 0, expression: 0, importedConstant: 0, noMatch: 0, outsidePack: 0, allHoles: 0,
      },
    },
    matches: { exact: 0, template: 0, multi: 0 },
    outboundEndpoints: 0,
    prefix: {},
    assumedAliases: 0,
    // The URLs nothing here answers, most common first. A count alone cannot be
    // acted on; this is the list a reader fixes a prefix or a missing module by.
    unmatchedUrls: [],
    // ---- the screen axis (RM30) --------------------------------------------
    // `declared` counts ROUTE DECLARATIONS that compose to a screen; `screens`
    // counts the nodes, which is smaller when two declarations compose to the
    // same path. Both are here because a reader comparing them is asking a real
    // question ("why are there fewer screens than routes?").
    screens: {
      declared: 0,
      screens: 0,
      withComponent: 0,
      componentUnresolved: 0,
      duplicatePaths: 0,
      hidden: 0,
      withParams: 0,
      // The specifiers that failed, most common first: the list a reader adds an
      // alias or a missing source root by.
      unresolvedSpecifiers: [],
      // The framework NAMES a screen's component in a frontend written before
      // modules, and a name that nothing registers is the same kind of gap as a
      // specifier that resolves to no file. Counted the same way, and listed so
      // a reader can see which name it was.
      unresolvedNames: [],
      renders: { EXACT: 0, SOUND_SET: 0, HEURISTIC: 0 },
      // The rule of SERVER_MENU_SUFFIXES, and the numbers behind whichever way
      // it went, so a reader can check it rather than take it. `detectedBy`
      // names what fired it, so a later rule cannot be mistaken for this one.
      serverDriven: {
        detected: false, detectedBy: null, routes: 0,
        ceiling: SERVER_MENU_ROUTE_CEILING, menuEndpoints: [],
      },
      // What the profile asked for and what was used. `nameSource` is refused
      // when it asks for a source this engine does not read.
      nameSource: { asked: 'none', used: 'none', refused: null },
      pathRule: null,
      codeRegex: null,
      codeLength: null,
      enabled: false,
      // A screen is a router declaration or a SERVER-RENDERED PAGE (RM48), and
      // a hybrid application has both. Counted apart, because they are found by
      // two different routes and a reader comparing them is asking a real
      // question.
      byKind: { router: 0, page: 0 },
    },
    // The server-rendered pages: how many templates this run read, how many of
    // them a handler names, and what the view names that resolved to nothing
    // were. `unrendered` is the honest other half — a fragment nobody pulls in
    // or a page nobody serves, whose links are nobody's calls.
    templates: {
      files: 0, byEngine: {}, rendered: 0, unrendered: 0, includes: 0,
      views: 0, viewNames: 0, redirects: 0, unresolvedViews: 0,
      // View names that resolved to no template this run read, counted by
      // OCCURRENCE. `viewNames` counts occurrences too and `byKind.page` counts
      // distinct pages, so the two can never be subtracted from one another:
      // four handlers naming one page are four names and one screen.
      viewNamesUnplaced: 0,
      unresolvedViewNames: [],
    },
    // The frontend's own call graph: how many functions send a request, how many
    // only lead to one, and how many nodes that adds up to. Everything else is
    // left out on purpose, so a pack does not double in size for utility code.
    functions: { withHttp: 0, reachingHttp: 0, created: 0 },
    callsEdges: { EXACT: 0, SOUND_SET: 0, HEURISTIC: 0 },
    // The same edges by the RULE that found them, so a reader can tell a call
    // this lane followed from a function that was only handed over as a value.
    // A grade alone cannot: both can be SOUND_SET, for different reasons.
    callsByRule: { 'same-file': 0, 'esm-import': 0, 'passed-as-value': 0 },
  };
}
