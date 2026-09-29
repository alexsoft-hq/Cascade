// calls.mjs — which route does this frontend function ask the server for?
//
// WHAT THIS MODULE OWNS. Everything between "the worker saw a call with a URL
// in it" and "there is a CALLS_HTTP edge on the graph":
//   the route index      the paths this pack SERVES, and how a call path is
//                        matched against them (`routeMatches`, `buildRouteIndex`)
//   the wrapper fixpoint a function that hands a request on without knowing
//                        which one, traced back to the client it ends at
//   the classification   which of the six kinds of sink a call reached, and
//                        what HTTP method it sends
//   the edges            the CALLS_HTTP edge, its grade, its evidence, and the
//                        outbound endpoint node for a URL nothing here answers
//   the frontend's own   `function --CALLS--> function`, and the rule that
//   call graph           decides which functions become nodes at all
//
// WHAT IT MUST NEVER KNOW ABOUT: how a prefix was decided (it is handed
// `prefixOf` and reads the answer), what a screen is, or what the template
// engine did. The one thing it knows about server-rendered pages is that a page
// writes its paths from the application root, and even that arrives as a
// prefix object it does not build.

import {
  cmp, normalizeUrl, GRADE_RANK, FIXPOINT_LIMIT,
} from './shared.mjs';
import { routeMatches } from '../http_routes.mjs';
import { isComponentFile, memberIndex, webEndpointId, webSymbolId } from './symbols.mjs';
import { TEMPLATE_PREFIX } from './prefix.mjs';
import { UNSETTLED_BECAUSE, walkChain } from './chain.mjs';
import { namedHopsOf } from '../../core/rules/kinds/web_wrapper_hop.mjs';
import { gatewayRouteOf } from '../../core/profile.mjs';
import { routeAddressOf } from '../../core/walks.mjs';
import {
  declaredValueOf, envNamesOf, envReadOfSpelling, fillFromExpression, isLocalHost, otherPortOf, unsettledPortOf,
} from './base_url.mjs';

/**
 * The two evidence rules RM60 added, spelled here the way the worker stamps
 * them. The word is written twice on purpose, the same way `router-navigation`
 * is: the bridge does not import from the worker, so a shared constant would be
 * a dependency in the direction this lane does not have.
 */
const FORM_SUBMIT_RULE = 'form-submit';
/** The rule a WebSquare submission call carries: `adapters/web/lib/websquare_calls.mjs` names it too. */
const SUBMISSION_RULE = 'websquare-submission';
const LOCATION_REQUEST_RULE = 'location-request';

/** What each evidence layer actually did, in one sentence, for `evidence.basis`. */
export const WEB_CALL_BASIS = Object.freeze({
  platform: 'the call goes to a browser sink (fetch / XMLHttpRequest), which sends the request itself: the URL argument is the URL by contract, and no rule had to decide that this call is an HTTP call',
  library: 'the callee is an instance of an HTTP client library a declaration pack names (adapters/web/packs/http-clients.json), and the method called is one of that library\'s verbs, so the call sends a request and the URL it sends to is the argument the library reads',
  injected: 'the callee is a client the FRAMEWORK hands the function, named in a declaration pack (adapters/web/packs/http-clients.json) and found by parameter name inside a function the framework fills in. Nothing in the file binds it, so there was nothing to trace: the pack says that parameter is a client and the method called is one of its verbs',
  // RM67. A client a class asks for by TYPE, and the framework fills in.
  typed: 'the callee is a field its class declares with a TYPE a declaration pack names as an HTTP client (adapters/web/packs/http-clients.json, instanceTypes), imported from that client\'s own module; the field is a constructor parameter or is set from the framework\'s injector (adapters/web/packs/injection.json). The framework fills it with an instance of that type, and the method called is one of its verbs, so the call sends a request and the URL it sends to is the argument the client reads',
  wrapper: 'the callee was traced through the project\'s own wrapper(s) to a client library instance, by following what each name is BOUND to in its file and what each wrapper forwards. The chain is on the edge; every hop is a binding this lane read, not a name it recognized',
  untraced: 'the argument is URL-shaped but the callee could not be traced to any sink: the call may send this URL or may only build it, so the edge says a rule guessed and the grade is HEURISTIC',
  template: 'the page itself makes this request: a `<form action=…>` posts to it, or a link opens it. The markup names the path and the attribute names the method, so nothing had to be traced and nothing was assumed',
  // RM60. The two requests a server-rendered page makes from its own script.
  form: 'the page assigns this address to a form and submits that form from script (`form.action = …; form.submit()`), which is how a server-rendered page sends everything it does not send with a link. Nothing had to be traced: the address is the assignment nearest before the submit on the same form in the same function, else the `action` of the form element itself, and the method is what the page assigned, else the `method` of the `<form>` element that name resolves to, else GET for a form the page built itself',
  location: 'the page tells the browser to load this address (`location.href = …`, `location.assign(…)`). A server-rendered page has no router, so nothing but the server can answer it: the browser fetches the route, exactly as it does for a link in the same page, and the method is GET by that contract',
  // RM56. A Nexacro client sends every request through one framework call, so
  // there is no client library to trace and no wrapper chain to follow.
  nexacro: 'the screen calls `transaction(…)`, which is the ONE way a Nexacro client sends a request: the framework opens the connection and the url is the argument, or the property of the options object, that it reads. The service prefix on the front of it (`svcurl::`) is resolved through the application typedef\'s own `<Service prefixid url>` list, so nothing here was matched by name',
  // RM63. A WebSquare page declares its requests and sends one by naming it.
  websquare: 'the page sends a submission it declares in its own model (`<xf:submission id action method>`), by a call a declaration pack names (adapters/web/packs/websquare.json): the address and the method are the declaration\'s, or the options object\'s the call is handed, so nothing had to be traced and nothing was matched by name',
});

/**
 * Whether one ROUTE path template matches one CALL path template. The rule is
 * `src/adapters/http_routes.mjs`'s, because the Java lane asks the same question
 * of a service-to-service call; re-exported here so every importer of this
 * module still finds it where it has always been.
 */
export { routeMatches };

/**
 * A URL TEMPLATE THAT IS NOTHING BUT HOLES NAMES NO ROUTE.
 *
 * `` `/${a}/${b}/${c}` `` resolves to `/{*}/{*}/{*}`, which matches every
 * three-segment route this pack serves: on the largest frontend measured for
 * this round that is 413 of them,
 * from ONE call site. Those are not 413 facts, they are one absence, and
 * writing them would put 5 000 edges in the pack and tell every three-segment
 * route that hundreds of screens call it. So a template with no literal
 * segment left in it is counted as unresolved and gets no edge; the count
 * says how many, and the URL is in the unmatched list under its own reason.
 *
 * A SEGMENT is evidence when text survives taking its holes out: `pre{*}` is,
 * `{*}` is not, and neither is `{*}{*}` (two interpolations written next to
 * each other, which is still nothing but interpolation).
 */
export function namesARoute(template) {
  return normalizeUrl(template).split('/').slice(1)
    .some((seg) => seg.split('{*}').join('') !== '');
}

/**
 * Whether a route serves a call's method: a call whose method was not read
 * (null, or keyed ANY) may be any of them, and a route declared for no method
 * (ANY) serves every one. The one rule a frontend call is matched by, here and
 * wherever a note asks the same question (src/cli/commands/analyze/prefix_notes.mjs).
 *
 * @param {string|null|undefined} routeMethod  the endpoint node's httpMethod
 * @param {string|null|undefined} callMethod   the call's method, null when unread
 * @returns {boolean}
 */
export function routeServesMethod(routeMethod, callMethod) {
  const route = routeMethod ?? 'ANY';
  return callMethod == null || callMethod === 'ANY' || route === 'ANY' || route === callMethod;
}

/** A route that serves whatever lies below its prefix (`/admin-api/ai/**`). */
const isCatchAll = (routePath) => routePath.endsWith('/**');

/**
 * B6: the routes this pack SERVES, indexed the two ways a call is matched
 * against them — exactly, and by template. A route carries how sure its own
 * ADDRESS is when its lane could not settle it (core/walks.mjs routeAddressOf),
 * so a call matched to it is graded by that too.
 *
 * A CATCH-ALL IS THE ANSWER ONLY WHERE NOTHING MORE SPECIFIC CAN BE (RM67-J4).
 * Spring serves a `/**` route only when no more specific route matches. The
 * pack shows that no route it recorded does; it cannot show it when a path
 * prefix set in code was not read (`unreadPrefix`), because every route may
 * then be served under a prefix the pack does not record. So a call whose match
 * lands on catch-alls alone is looked up again with its leading segments
 * dropped, the shortest drop first, and a route that matches then is a
 * candidate too (`shifted`); the whole set is a guess then (`unsettled`), since
 * which one Spring serves rests on the prefix nobody declared. With no such
 * route in the pack, the catch-all stays the only candidate there can be.
 *
 * @param {import('../../core/graph.mjs').Graph} g
 * @param {{unreadPrefix?:(string|null)}} [opts]  why the recorded addresses may lack a prefix
 * @returns {{exactPaths:Set<string>, templatePaths:string[], matchUrl:Function}}
 */
export function buildRouteIndex(g, opts = {}) {
  const exactPaths = new Set();
  const templatePaths = [];
  const routesByPath = new Map(); // normalized path -> [{id, httpMethod, path, address}]
  for (const n of g.nodes.values()) {
    if (n.kind !== 'endpoint' || n.outbound === true || typeof n.path !== 'string') continue;
    const p = normalizeUrl(n.path);
    if (!routesByPath.has(p)) routesByPath.set(p, []);
    routesByPath.get(p).push({ id: n.id, httpMethod: n.httpMethod ?? 'ANY', path: p, address: routeAddressOf(g, n.id) });
    exactPaths.add(p);
    templatePaths.push(p);
  }
  templatePaths.sort();
  const allRoutes = [...routesByPath.keys()].sort();

  const methodOk = (route, method) => routeServesMethod(route.httpMethod, method);
  const plainMatch = (p, method) => {
    const exact = (routesByPath.get(p) ?? []).filter((r) => methodOk(r, method));
    if (exact.length > 0) return { how: 'exact', routes: exact };
    const hits = [];
    for (const rp of allRoutes) {
      if (rp === p) continue;
      if (!routeMatches(rp, p)) continue;
      for (const r of routesByPath.get(rp)) if (methodOk(r, method)) hits.push(r);
    }
    return hits.length > 0 ? { how: 'template', routes: hits } : { how: null, routes: [] };
  };
  const matchUrl = (full, method) => {
    const p = normalizeUrl(full);
    const found = plainMatch(p, method);
    if (!opts.unreadPrefix || found.how !== 'template' || !found.routes.every((r) => isCatchAll(r.path))) return found;
    return { ...found, ...shiftedMatch(p, method, plainMatch, opts.unreadPrefix) };
  };
  return { exactPaths, templatePaths, matchUrl };
}

/**
 * The routes a call matches once its leading segments are taken off, the
 * shortest drop first, catch-alls left out: what a path prefix nobody declared
 * could make the more specific route Spring serves instead. Empty when no drop
 * finds one, which leaves the catch-all the only candidate there can be.
 */
function shiftedMatch(p, method, plainMatch, why) {
  const segs = p.split('/').slice(1);
  for (let k = 1; k < segs.length; k += 1) {
    const m = plainMatch(`/${segs.slice(k).join('/')}`, method);
    const routes = m.routes.filter((r) => !isCatchAll(r.path));
    if (routes.length > 0) return { unsettled: why, shifted: { dropped: `/${segs.slice(0, k).join('/')}`, how: m.how, routes } };
  }
  return {};
}

/**
 * What a CALL's callee resolves to. Four answers, and the grade of the edge
 * follows from which one it is:
 *   sink      the callee IS a client instance or a platform sink
 *   member    the callee is a function/method of this project (maybe a wrapper)
 *   external  the callee comes from a package this analysis never read
 *   null      nothing here explains it
 */
/**
 * What `this.<field>…` names: a method of this class, or through a field, the
 * client or the project class that field holds. A field whose TYPE the class
 * states (RM67) says so on the answer (`typed`), because what it holds may be a
 * class a provider puts in the type's place.
 */
function thisTarget(fieldValue, file, className, pathParts) {
  if (pathParts.length === 1) {
    return { kind: 'member', key: `${file}#${className}.${pathParts[0]}`, assumed: false, viaStar: false };
  }
  if (pathParts.length < 2) return null;
  const v = fieldValue(file, className, pathParts[0], 0);
  const flags = { assumed: v?.assumed === true, viaStar: v?.viaStar === true, ...(v?.typed ? { typed: v.typed } : {}) };
  if (v && v.kind === 'sink-instance') return { kind: 'sink', instance: v, method: pathParts[1], ...flags };
  if (v && v.kind === 'class-instance') {
    const at = v.key.lastIndexOf('#');
    return { kind: 'member', key: `${v.key.slice(0, at)}#${v.key.slice(at + 1)}.${pathParts[1]}`, ...flags };
  }
  return null;
}

/**
 * A FUNCTION WRITTEN INSIDE AN OBJECT LITERAL, called the way its caller spells
 * it (R2-K): `request.get(…)` where `request` holds `export default { get: … }`.
 * The worker recorded whose each such function is, so the key is looked up by
 * name and never guessed from any function spelled `get` in that file.
 */
function objectMember(members, root, key, flags) {
  const fn = members.get(`${root.file}#${root.name}.${key}`) ?? null;
  return fn === null ? null : { kind: 'member', key: `${root.file}#${fn.name}`, ...flags };
}

function makeCalleeTarget({ libraries, packageOf, resolver, members }) {
  const { rootValue, fieldValue } = resolver;
  return (file, call) => {
    const callee = call.callee ?? null;
    if (!callee) return null;
    const pathParts = callee.path ?? [];
    const binding = call.binding ?? null;
    if (binding && binding.kind === 'this') {
      return binding.class ? thisTarget(fieldValue, file, binding.class, pathParts) : null;
    }
    const root = rootValue(file, callee, binding, 0);
    if (root === null) return null;
    const flags = { assumed: root.assumed === true, viaStar: root.viaStar === true };
    if (root.kind === 'external' || root.kind === 'namespace') {
      const module = root.kind === 'external' ? root.module : null;
      // A library known by its instance TYPE (RM67) is a client only through
      // an instance: calling what its module exports sends nothing.
      const lib = module && !libraries.get(module)?.instanceTypes ? libraries.get(module) : null;
      if (lib && pathParts.length <= 1) {
        return {
          kind: 'sink',
          instance: { kind: 'sink-instance', module: lib.module, baseURL: null, id: `${packageOf(file)}#(module ${lib.module})` },
          method: pathParts.length === 1 ? pathParts[0] : null,
          ...flags,
        };
      }
      return { kind: 'external', module, ...flags };
    }
    if (root.kind === 'sink-instance' && pathParts.length <= 1) {
      return { kind: 'sink', instance: root, method: pathParts.length === 1 ? pathParts[0] : null, ...flags };
    }
    if (root.kind === 'class-instance' && pathParts.length === 1) {
      const at = root.key.lastIndexOf('#');
      return { kind: 'member', key: `${root.key.slice(0, at)}#${root.key.slice(at + 1)}.${pathParts[0]}`, ...flags };
    }
    if (root.kind === 'function' && pathParts.length === 0) {
      return { kind: 'member', key: root.key, ...flags };
    }
    if (root.kind === 'object' && pathParts.length === 1) return objectMember(members, root, pathParts[0], flags);
    return null;
  };
}

/** Whether a call spells its own URL out, which is what makes its caller an API function. */
const hasOwnUrl = (c) => !!(c.url && Array.isArray(c.url.resolved) && c.url.resolved.length > 0);

/** Every function this lane read, and every call written inside each of them. */
function indexMembers({ fileNames, files }) {
  const memberKeys = [];
  const memberRec = new Map();
  for (const file of fileNames) {
    for (const [name, rec] of files.get(file).functions) {
      const key = `${file}#${name}`;
      memberKeys.push(key);
      memberRec.set(key, { file, name, rec });
    }
  }
  memberKeys.sort();
  const callsIn = new Map(); // member key -> call records
  for (const file of fileNames) {
    for (const c of files.get(file).calls) {
      const key = `${file}#${c.enclosing}`;
      if (!callsIn.has(key)) callsIn.set(key, []);
      callsIn.get(key).push(c);
    }
  }
  return { memberKeys, memberRec, callsIn };
}

/**
 * ONE ROUND of the fixpoint for one function: the shortest hop it has towards a
 * client, or null when it has none. Ties are broken by the name of the next hop,
 * so two runs over the same facts pick the same chain.
 */
function wrapperStep(ctx, key) {
  const { memberRec, callsIn, wrappers, calleeTarget, sinkVerb } = ctx;
  const m = memberRec.get(key);
  if (!m) return null;
  const cands = [];
  const consider = (cand) => { if (cand) cands.push(cand); };
  for (const c of callsIn.get(key) ?? []) {
    if (hasOwnUrl(c)) continue;
    // A PLATFORM SINK IS A HOP whatever its callee resolves to: a GLOBAL
    // `fetch` binds nothing, so the callee resolves to nothing, and asked after
    // that it was never reached (a function handing its request to `fetch` was
    // never a wrapper). The call record already says what it is.
    if (c.platformSink) {
      const verb = c.method && c.method.from === 'callee-name' ? c.method.value : null;
      consider({ depth: 1, next: null, sink: { module: c.platformSink, instance: null, kind: 'platform' }, call: c, verb });
    }
    const t = calleeTarget(m.file, c);
    if (!t) continue;
    if (t.kind === 'sink') {
      const v = sinkVerb(t);
      if (!v) continue;
      consider({ depth: 1, next: null, sink: { module: t.instance.module, instance: t.instance.id ?? null, kind: 'library' }, call: c, verb: v.verb ?? null });
    } else if (t.kind === 'member' && t.key !== key) {
      const w = wrappers.get(t.key);
      if (!w) continue;
      consider({ depth: 1 + w.depth, next: t.key, sink: w.sink, call: c });
    }
  }
  hopsWithoutACallRecord(ctx, key, m, consider);
  return withBranches(cands);
}

/**
 * THE STEP A FUNCTION IS, from every call in it that leads to a client: the
 * shortest (ties broken by the name of the next step, so two runs pick the
 * same), and beside it every other call that leads on the same way (`hops`,
 * each with the verb its client call names), because either may be the one
 * that runs (review 3, R1). A return that repeats a call already read is the
 * same call. Calls that lead on to a different client are counted (`forks`).
 */
function withBranches(cands) {
  if (cands.length === 0) return null;
  const best = cands.reduce((a, b) => (b.depth < a.depth || (b.depth === a.depth && cmp(b.next ?? '', a.next ?? '') < 0) ? b : a));
  const same = (c) => (c.next ?? null) === (best.next ?? null) && c.sink.module === best.sink.module && (c.sink.instance ?? null) === (best.sink.instance ?? null);
  const hops = [{ call: best.call ?? null, verb: best.verb ?? null }];
  let forks = 0;
  for (const c of cands) {
    if (c === best || (c.call === null && cands.some((o) => o.call !== null && (o.next ?? null) === (c.next ?? null)))) continue;
    if (!same(c)) forks += 1;
    else if (!hops.some((h) => h.call === c.call)) hops.push({ call: c.call ?? null, verb: c.verb ?? null });
  }
  return { ...best, hops, forks };
}

/** One hop to a wrapper written somewhere other than a call record, when it is one. */
function hopToAWrapper(ctx, key, file, written, call, consider) {
  const t = ctx.calleeTarget(file, { callee: written.callee, binding: written.binding ?? null });
  if (!t || t.kind !== 'member' || t.key === key) return;
  const w = ctx.wrappers.get(t.key);
  if (w) consider({ depth: 1 + w.depth, next: t.key, sink: w.sink, call });
}

/**
 * THE HOPS THE FUNCTION RECORD CARRIES rather than a call record. A forward
 * (R2-K) is a call on a helper this file declares that hands on what the
 * function was given, `get: (option) => request({ method: 'GET', ...option })`;
 * it is the hop, so it is what the method and the URL are read from. A return
 * is `get(config) { return this.request({ …config, method: 'GET' }) }` written
 * as a return, and a body with no call record left (an arrow that IS the call)
 * is only visible that way. Forwards first: where both name the same hop, the
 * one that says what it hands on is kept.
 */
function hopsWithoutACallRecord(ctx, key, m, consider) {
  for (const fwd of m.rec.forwards ?? []) {
    if (fwd && fwd.callee) hopToAWrapper(ctx, key, m.file, fwd, fwd, consider);
  }
  const ret = m.rec.returns ?? null;
  if (ret && ret.callee) hopToAWrapper(ctx, key, m.file, ret, null, consider);
}

/** Whether a sink instance really is being CALLED here, per its library's vocabulary. */
function makeSinkVerb(libraries) {
  return (target) => {
    const lib = libraries.get(target.instance.module);
    if (!lib) return null;
    const name = target.method;
    if (name === null) {
      return (lib.generic ?? []).includes('(call)') ? { verb: null, generic: true } : null;
    }
    const verbs = lib.verbs ?? {};
    if (Object.prototype.hasOwnProperty.call(verbs, name)) return { verb: verbs[name], generic: false };
    if ((lib.generic ?? []).includes(name)) return { verb: null, generic: true };
    return null;
  };
}

/**
 * What kind of function a wrapper is: a method of an object literal (R2-K), a
 * class method (`Class.method`), or a function.
 */
function wrapperKindOf(key, memberRec) {
  if (typeof memberRec.get(key)?.rec?.member === 'string') return 'objectMethod';
  return key.slice(key.lastIndexOf('#') + 1).includes('.') ? 'classMethod' : 'function';
}

/**
 * THE STEPS A RULE PACK NAMES (`web.wrapper-hop`), marked on the wrapper map:
 * a step of the class the rule's shape found, that calls the rule's client
 * through an instance the class itself holds. The chain walk reads such a step
 * as the rule says (named_hop.mjs); any other step is read as its code reads.
 */
function markNamedSteps(wrappers, records, hopRules) {
  for (const [key, named] of namedHopsOf(records, hopRules)) {
    const w = wrappers.get(key);
    const own = key.slice(0, key.lastIndexOf('.') + 1);
    if (!w || w.sink.kind !== 'library' || w.sink.module !== named.hop.client.module) continue;
    if (typeof w.sink.instance === 'string' && w.sink.instance.startsWith(own)) wrappers.set(key, { ...w, named });
  }
}

/**
 * B4: the wrapper fixpoint.
 *
 * A WRAPPER is a function that hands a request on without knowing which one:
 * it contains a call to a sink (or to another wrapper) whose URL argument is
 * NOT a literal of its own. A function whose inner call spells the URL out is
 * an API function, and it is the thing that gets a node and an edge.
 *
 * @returns {{wrappers:Map, calleeTarget:Function, sinkVerb:Function, platformOf:Function}}
 */
export function traceWrappers({
  fileNames, files, libraries, pack, packageOf, resolver, stats, records = [], hopRules = [],
}) {
  const calleeTarget = makeCalleeTarget({ libraries, packageOf, resolver, members: memberIndex(files) });
  const sinkVerb = makeSinkVerb(libraries);
  /** The instance a platform sink belongs to: none. The URL is the URL. */
  const platformOf = (call) => {
    if (!call.platformSink) return null;
    return (pack.platform ?? []).find((p) => p.name === call.platformSink) ?? { name: call.platformSink };
  };

  const { memberKeys, memberRec, callsIn } = indexMembers({ fileNames, files });
  const wrappers = new Map(); // key -> {depth, next, sink}
  const ctx = { memberRec, callsIn, wrappers, calleeTarget, sinkVerb };
  for (let round = 0; round < FIXPOINT_LIMIT; round += 1) {
    let changed = false;
    for (const key of memberKeys) {
      const next = wrapperStep(ctx, key);
      if (next === null) continue;
      const prev = wrappers.get(key);
      if (!prev || prev.depth !== next.depth || prev.next !== next.next) { wrappers.set(key, next); changed = true; }
    }
    if (!changed) break;
  }
  // Which calls lead on is read once more against the settled map.
  for (const key of [...wrappers.keys()]) wrappers.set(key, wrapperStep(ctx, key) ?? wrappers.get(key));
  markNamedSteps(wrappers, records, hopRules);
  stats.wrappers.count = wrappers.size;
  for (const [key, w] of wrappers) {
    stats.wrappers.maxDepth = Math.max(stats.wrappers.maxDepth, w.depth);
    stats.wrappers.byKind[wrapperKindOf(key, memberRec)] += 1;
  }
  return { wrappers, calleeTarget, sinkVerb, platformOf };
}

/**
 * Whether a resolved URL is WRITTEN like one: a leading slash, or an absolute
 * address. A URL that never resolved is kept (its shape is unknown, and it is
 * counted by reason further down); one that resolved to a bare word is not.
 */
function urlShaped(absolute, resolved) {
  if (absolute) return true;
  if (!Array.isArray(resolved)) return true;
  return resolved.some((r) => typeof r.template === 'string' && r.template.startsWith('/'));
}

/**
 * A page's URL candidates with the CONTEXT PATH taken off the front.
 *
 * `base_url + '/jobinfo/pageList'` resolves to `{*}/jobinfo/pageList` in the
 * worker, because the file it is written in does not assign `base_url` — the
 * layout it includes does. Only the include graph knows that, so only here can
 * the hole be recognised as the app root and removed. The result is the path the
 * server sees, and everything downstream reads it as one.
 */
function withContextPath(call, contextVars, from) {
  const resolved = Array.isArray(from) ? from : null;
  if (resolved === null || contextVars === null) return resolved;
  if (typeof call.url.base !== 'string' || !contextVars.has(call.url.base)) return resolved;
  return resolved.map((r) => (typeof r.template === 'string' && r.template.startsWith('{*}')
    ? {
      ...r,
      template: r.template.slice(3),
      dynamicParts: Math.max(0, (r.dynamicParts ?? 1) - 1),
      // The hole goes with the text it stood for: it is the app root, which is
      // explained, so it is no longer one of the holes this call is left with.
      ...(Array.isArray(r.holes) ? { holes: r.holes.slice(1) } : {}),
    }
    : r));
}

// ---------------------------------------------------------------------------
// THE OTHER HALF OF THE SUBSTITUTION (RM58)
//
// The worker fills in a constant the SAME FILE declares, because that is all
// one file can state. `import { POSTS_URL } from '@/constants/api'` is the same
// shape written across two files, and following it needs the specifier rules,
// the aliases and the export chain — which live here, and which this lane
// already uses to say which function a call names. So the worker leaves such a
// hole with the specifier on it and the bridge finishes it.
//
// The VALUE is still a literal somebody wrote: what is added here is only which
// file it is in. Where the file was found through an ASSUMED alias, the site is
// marked assumed and grades down, the same as everything else that rests on
// that guess.
//
// AN ENVIRONMENT READ AT THE FRONT OF A URL IS A BASE URL written at the call
// site: `API_BASE_URL + '/polls'` with `API_BASE_URL = process.env.X ||
// 'http://localhost:8080/api'`. Its value is a build fact, read the way a
// client's base URL is (base_url.mjs), and it goes in only when every build
// gives it one path. What it rests on goes with it: a default literal, or a
// host that is not this machine, grades the call HEURISTIC.
// ---------------------------------------------------------------------------

/**
 * The text an imported constant holds, or the value the build decides that it
 * is bound to (`expr`, base_url.mjs declaredValueOf), or neither. Memoized per
 * (file, hole).
 */
function makeConstantOf({ files, resolver }) {
  const { resolveSpecifier, resolveExport } = resolver;
  const memo = new Map();
  return (file, hole) => {
    const key = `${file} ${hole.source} ${hole.imported} ${hole.name}`;
    if (memo.has(key)) return memo.get(key);
    const out = { value: null, assumed: false, expr: null };
    const dot = String(hole.name).indexOf('.');
    const member = dot > 0 ? hole.name.slice(dot + 1) : null;
    // `a.b.c` is a path through objects nobody recorded, and it is refused the
    // same way a call through one is.
    const tooDeep = member !== null && member.includes('.');
    const namespace = hole.imported === '*';
    const wanted = namespace ? member : hole.imported;
    const r = typeof hole.source === 'string' && !tooDeep && wanted !== null
      ? resolveSpecifier(file, hole.source) : {};
    const hit = r.file ? resolveExport(r.file, wanted, 0) : null;
    if (hit && !hit.external && hit.file) {
      const got = declaredValueOf(files, hit.file, hit.name, namespace || member === null ? null : member);
      if (got !== null && got.kind === 'string') out.value = got.value;
      else if (got !== null) out.expr = got;
      out.assumed = got !== null && (r.assumed === true || hit.assumed === true);
    }
    memo.set(key, out);
    return out;
  };
}

/**
 * What ONE hole of a call's URL is filled with, and what that rests on.
 *
 * An imported constant's literal goes in wherever its hole is (RM58). An
 * environment read goes in only at the FRONT of the URL, where it is a base
 * URL, and only when every build gives it one path: a value in the middle of
 * a path, or one the builds disagree about, stays a hole, counted as `env`.
 *
 * @returns {(file:string, pkg:string, hole:object, leading:boolean) => object}
 */
function makeHoleFiller({ constantOf, configFor, ports }) {
  const NONE = { value: null, assumed: false };
  const fromBuild = (pkg, expr, hole, assumed) => {
    const got = expr === null ? null : fillFromExpression(configFor(pkg), expr, ports);
    if (got === null) return { ...NONE, hole };
    return {
      value: got.text, assumed, from: got.from, env: envNamesOf(expr), guess: got.guess, reads: got.reads,
      ...(got.away ? { away: got.away } : {}), ...(got.modes ? { modes: got.modes } : {}),
    };
  };
  return (file, pkg, h, leading) => {
    if (!h) return NONE;
    if (h.kind === 'import') {
      const got = constantOf(file, h);
      if (typeof got.value === 'string') return { value: got.value, assumed: got.assumed, from: 'import' };
      if (got.expr === null) return NONE;
      const hole = { ...h, kind: 'env' };
      return leading ? fromBuild(pkg, got.expr, hole, got.assumed) : { ...NONE, hole };
    }
    if (h.kind !== 'env' || !leading) return NONE;
    return fromBuild(pkg, h.expr ?? envReadOfSpelling(h.name), h, false);
  };
}

/**
 * THE URL THAT IS NOTHING BUT AN IMPORTED CONSTANT.
 *
 * `get(ACCESS_TOKEN)` and `axios.get(POSTS_URL)` are the same shape as the holes
 * above with the template taken away, and RM58 filled only the holes: a URL
 * argument that IS the imported name resolved to nothing, so it was counted
 * `importedConstant` and left. Measured on jsherp, 27 of 56 unresolved call
 * sites were that, and not one of them was a URL: they are the keys of a
 * browser-storage wrapper (`Vue.ls.get(ACCESS_TOKEN)`), which the verb-name
 * convention reads as a URL argument and only the value can settle.
 *
 * So the value is read here too, and it decides the call in BOTH directions: a
 * constant that holds a path resolves the call, and one that holds anything else
 * is not URL-shaped, which is how `sinkOf` already recognises a call that never
 * was one. Nothing is guessed either way, because the literal is in the source.
 *
 * @returns {{resolved:object[], substituted:object[], assumed:boolean}|null}
 *          null when the URL is not a bare imported name
 */
function wholeImportedConstant(file, call, constantOf) {
  const url = call.url ?? {};
  if (Array.isArray(url.resolved) || url.unresolved !== 'imported-constant') return null;
  const binding = url.binding ?? null;
  const arg = url.arg ?? null;
  if (binding === null || binding.kind !== 'import' || arg === null) return null;
  const name = arg.kind === 'ident' ? arg.name
    : arg.kind === 'member' ? [arg.root, ...(arg.path ?? [])].join('.') : null;
  if (name === null) return null;
  const got = constantOf(file, { kind: 'import', name, source: binding.source, imported: binding.imported });
  if (typeof got.value !== 'string') return null;
  return {
    resolved: [{ template: got.value, dynamicParts: 0, via: 'imported-constant' }],
    substituted: [{ name, value: got.value, from: 'import' }],
    assumed: got.assumed === true,
  };
}

/**
 * What one filled hole adds to the call: the substitution a reader traces the
 * text back by, the alias it may rest on, and, for an environment read at the
 * front, the guess its value may rest on.
 */
function noteFill(acc, h, got) {
  acc.assumed = acc.assumed || got.assumed === true;
  if (got.from !== 'import') {
    acc.leadingBase = true;
    if (acc.guess === null && got.guess) acc.guess = got.guess;
    if (got.away) acc.away = got.away;
    if (got.modes) acc.modes = got.modes;
  }
  if (acc.substituted.some((s) => s.name === h.name && s.value === got.value)) return;
  acc.substituted.push({
    name: h.name, value: got.value, from: got.from,
    ...(got.env ? { env: got.env } : {}), ...(got.reads ? { reads: got.reads } : {}),
  });
}

/** One URL candidate with every hole `fillAt` can fill filled in. */
function fillCandidate(cand, parts, holes, fillAt, acc) {
  const text = [];
  const remaining = [];
  for (let i = 0; i < holes.length; i += 1) {
    text.push(parts[i]);
    const got = fillAt(holes[i], i);
    if (typeof got.value !== 'string') { text.push('{*}'); remaining.push(got.hole ?? holes[i]); continue; }
    text.push(got.value);
    noteFill(acc, holes[i], got);
  }
  text.push(parts[parts.length - 1]);
  if (remaining.length === holes.length) return { ...cand, holes: remaining };
  return {
    ...cand, template: text.join(''), dynamicParts: remaining.length, holes: remaining,
  };
}

/**
 * One call's URL candidates with every hole an IMPORTED constant explains
 * filled in, and an environment read at the front of it (see makeHoleFiller),
 * and what that took.
 *
 * @returns {{resolved:object[], substituted:object[], assumed:boolean,
 *            guess:(string|null), leadingBase:boolean}}
 */
function withImportedConstants(file, pkg, call, from, fill) {
  const resolved = Array.isArray(from) ? from : null;
  const url = call.url ?? {};
  const acc = {
    substituted: [], assumed: false, guess: null, leadingBase: false, away: null, modes: null,
  };
  if (resolved === null || resolved.length === 0) return { resolved, ...acc };
  const one = resolved.length === 1;
  const out = resolved.map((cand) => {
    const holes = Array.isArray(cand.holes) ? cand.holes
      : (one && Array.isArray(url.holes) ? url.holes : null);
    if (holes === null || holes.length === 0) return cand;
    const parts = String(cand.template).split('{*}');
    // The hole list and the `{*}` have to line up, or a value would land in the
    // wrong place, and a wrong path is worse than a hole.
    if (parts.length - 1 !== holes.length) return { ...cand, holes };
    return fillCandidate(cand, parts, holes, (h, i) => fill(file, pkg, h, i === 0 && parts[0] === ''), acc);
  });
  return { resolved: out, ...acc };
}

/**
 * The address a filled-in template turns out to name, when a constant put a
 * HOST on the front of it, and the path with that host taken off.
 *
 * The worker does this for the text it resolves itself (`buildUrl`); a value
 * that arrived from another module has not been through it, and a call whose
 * template suddenly starts with `https:` would be read as not URL-shaped at
 * all and dropped.
 */
function withoutHost(resolved) {
  let absolute = null;
  const out = resolved.map((r) => {
    let t = r.template;
    if (typeof t !== 'string') return r;
    const abs = /^(https?:)?\/\/([^/]+)(\/.*)?$/.exec(t);
    if (abs) {
      if (absolute === null) absolute = { host: abs[2], path: abs[3] ?? '/' };
      t = abs[3] ?? '/';
    }
    const q = t.indexOf('?');
    if (q >= 0) t = t.slice(0, q);
    return t === r.template ? r : { ...r, template: t };
  });
  return { resolved: out, absolute };
}

/** Where a value the BRIDGE put into a URL was read; anything else is the worker's same-file one. */
const BRIDGE_FILLS = new Set(['import', 'env-file', 'fallback']);

/**
 * The holes a call site is LEFT with, and the constants that went into it.
 *
 * Counted per call site and once per distinct hole: a template that names the
 * same parameter twice is one thing a reader cannot see, not two.
 */
function countUrlCensus(stats, resolved, substituted, guess) {
  for (const s of substituted) {
    const from = BRIDGE_FILLS.has(s.from) ? s.from : 'same-file';
    stats.url.substituted[from] = (stats.url.substituted[from] ?? 0) + 1;
  }
  // A URL whose front rests on a guess, by which guess: the axis names these.
  if (guess) {
    if (!stats.url.guessed) stats.url.guessed = {};
    stats.url.guessed[guess] = (stats.url.guessed[guess] ?? 0) + 1;
  }
  const seen = new Set();
  for (const cand of resolved ?? []) {
    for (const h of Array.isArray(cand.holes) ? cand.holes : []) {
      if (!h || typeof h.kind !== 'string') continue;
      const key = `${h.kind} ${h.name ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      stats.url.holes[h.kind] = (stats.url.holes[h.kind] ?? 0) + 1;
    }
  }
}

/**
 * THE METHOD THE LIBRARY'S OWN VERB TABLE STATES, for a verb whose name is not
 * spelled like one (`jsonp`, `del`), or the answer that there is none: a verb
 * that takes its method BY POSITION and was not handed one written out has no
 * default to fall back on, because the library requires the argument (RM67).
 *
 * @returns {{value:(string|null), from:string}|null} null when neither applies
 */
function libraryVerbOf(libraries, c, sink, target) {
  if (c.method && c.method.from === 'positional' && !c.method.value && sink.kind === 'library') {
    return { value: null, from: 'absent' };
  }
  if (sink.kind !== 'library' || !target || typeof target.method !== 'string') return null;
  const verbs = libraries.get(sink.module)?.verbs ?? {};
  return Object.prototype.hasOwnProperty.call(verbs, target.method) ? { value: verbs[target.method], from: 'library-verb' } : null;
}

/** Every step of the wrapper chain a call goes through, the caller's side first, with the calls each may make. */
function stepsOf(wrappers, key) {
  const steps = [];
  for (let cur = key, i = 0; cur && i < FIXPOINT_LIMIT; i += 1) {
    const w = wrappers.get(cur);
    if (!w) break;
    steps.push({ key: cur, hops: w.hops ?? [{ call: w.call ?? null, verb: w.verb ?? null }], forks: w.forks ?? 0, last: !w.next, named: w.named ?? null });
    cur = w.next ?? null;
  }
  return steps;
}

/**
 * THE KEYS A CLIENT READS ITS REQUEST FROM, as the HTTP client pack names them
 * (packs/http-clients.json): its method keys, its base URL key, and the
 * argument it takes options from when the URL comes on its own.
 */
function makeClientKeys({ libraries, pack }) {
  return (sink) => {
    if (sink.kind === 'platform') {
      const p = (pack.platform ?? []).find((x) => x.name === sink.module) ?? {};
      return { method: p.config?.methodKeys ?? [p.methodKey ?? 'method'], base: null, optionsArg: p.optionsArg ?? null };
    }
    const lib = libraries.get(sink.module) ?? {};
    return { method: [lib.configMethodKey ?? 'method'], base: lib.configBaseUrlKey ?? null, optionsArg: null };
  };
}

/**
 * THE CALLER'S REQUEST WALKED DOWN THE CHAIN (src/adapters/web/chain.mjs),
 * counted when a step does not settle it. A call whose URL position the
 * worker did not record is taken as reaching the client, with the method the
 * last step that writes one writes, or else its own.
 */
function walkThrough(wrappers, key, c, clientKeys, stats) {
  if (!c.url || !c.url.at) {
    const written = stepsOf(wrappers, key).map((st) => st.hops[0].call?.method).filter((m) => m && m.value && m.from !== 'callee-name');
    const own = c.method && c.method.value ? { value: c.method.value, from: c.method.from ?? 'config' } : null;
    return { reached: true, why: null, methods: [written.length > 0 ? { value: written[written.length - 1].value, from: 'wrapper-verb' } : own] };
  }
  const via = walkChain(stepsOf(wrappers, key), c, clientKeys(wrappers.get(key).sink));
  countNamed(stats, via);
  if (via.reached && via.why) {
    stats.calls.urlThroughUnreadHop += 1;
    stats.calls.unreadHopBy[via.why.why] = (stats.calls.unreadHopBy[via.why.why] ?? 0) + 1;
  }
  return via;
}

/** A call through a step a rule pack names, counted by the rule, and whether the rule settled it. */
function countNamed(stats, via) {
  if (!via.reached || !via.named) return;
  const rule = via.named[0].rule;
  const n = stats.calls.throughNamedStep[rule] ?? { calls: 0, settled: 0 };
  stats.calls.throughNamedStep[rule] = { calls: n.calls + 1, settled: n.settled + (via.why ? 0 : 1) };
}

/**
 * WHY A CALL WAS TRACED TO NO CLIENT, by what its callee turned out to be. The
 * words are the web axis's (src/core/lanes.mjs), so a reader sees the same
 * reason in the stats and in the note.
 */
export const UNTRACED_BECAUSE = Object.freeze({
  unbound: 'the function called is bound to nothing this lane follows (an object of functions, a parameter, a global)',
  external: 'the function called comes from a package the HTTP client pack does not name',
  'not-a-wrapper': 'the function called is this project\'s own and hands the request to no client this lane knows',
  'not-a-verb': 'a client is called through a method that is not one of its verbs',
});

/** What the callee of an untraced call turned out to be, as an UNTRACED_BECAUSE key. */
function untracedReasonOf(target) {
  if (target === null) return 'unbound';
  if (target.kind === 'external') return 'external';
  if (target.kind === 'member') return 'not-a-wrapper';
  return target.kind === 'sink' ? 'not-a-verb' : 'unbound';
}

/** One untraced call, counted by why and by the callee as written. */
function countUntraced(stats, c, why) {
  const u = stats.untraced;
  u.byReason[why] = (u.byReason[why] ?? 0) + 1;
  const callee = c.callee && typeof c.callee.root === 'string' ? [c.callee.root, ...(c.callee.path ?? [])].join('.') : '(expression)';
  const key = `${why} ${callee}`;
  u.callees[key] = (u.callees[key] ?? 0) + 1;
}

/** The method a client sends when nothing names one. */
function defaultMethodOf(sink, { libraries, pack, injectedClients }) {
  if (sink.kind === 'library' || sink.kind === 'wrapper') {
    const lib = libraries.get(sink.module);
    if (lib && lib.defaultMethod) return { value: lib.defaultMethod, from: 'library-default' };
  }
  // A wrapper that ends at `fetch` sends what `fetch` sends by default.
  if (sink.kind === 'platform' || sink.kind === 'wrapper') {
    const p = (pack.platform ?? []).find((x) => x.name === sink.module);
    if (p && p.defaultMethod) return { value: p.defaultMethod, from: 'library-default' };
  }
  if (sink.kind === 'injected') {
    const cl = injectedClients.get(sink.module);
    if (cl && cl.defaultMethod) return { value: cl.defaultMethod, from: 'library-default' };
  }
  return { value: null, from: 'absent' };
}

/**
 * EVERY HTTP METHOD this call may send, and what said so. Through a wrapper
 * chain it is what the walk found arrives (src/adapters/web/chain.mjs), one
 * per way through, the client's default where none does; a call on a client
 * says its own. A method written as something other than a verb (`{ method:
 * verb }`) is one this file does not state.
 */
function makeMethodsFor(deps) {
  const { libraries } = deps;
  return (c, sink, target) => {
    if (sink.kind === 'wrapper' && Array.isArray(sink.methods)) {
      const out = [];
      for (const m of sink.methods) {
        const x = m === null ? defaultMethodOf(sink, deps) : evidenceOfMethod(m);
        if (!out.some((y) => y.value === x.value)) out.push(x);
      }
      return out;
    }
    if (c.method && c.method.value) return [{ value: c.method.value, from: c.method.from ?? 'config' }];
    if (c.method && c.method.from === 'config') return [{ value: null, from: 'absent', written: 'variable' }];
    return [libraryVerbOf(libraries, c, sink, target) ?? defaultMethodOf(sink, deps)];
  };
}

/** A method the walk carried, in the words an edge says it with. */
function evidenceOfMethod(m) {
  const { places, ...said } = m;
  return said;
}

/**
 * THE METHODS THAT TAKE A PATH APART instead of asking for one.
 *
 * `pathname.startsWith('/auth/login/naver')` asks where the browser already is;
 * `p.split('/')`, `s.replace('/a', '/b')` and `re.test(path)` are how every
 * frontend reads a path. The argument is path-shaped by construction, so the URL
 * rule sees a URL and the callee reached no client, which is exactly the shape of
 * an untraced call: on the eGovFrame MSA template that was five of the nineteen
 * paths no route answered. The METHOD NAME settles it, whatever the receiver is,
 * because none of these sends anything.
 *
 * Applied ONLY to a call that reached no client, so a traced library instance
 * that happens to publish one of these names is untouched: there the sink is the
 * library, and this list is about a call that has no sink at all.
 */
export const STRING_METHODS = new Set([
  'startsWith', 'endsWith', 'includes', 'indexOf', 'lastIndexOf', 'match', 'test',
  'replace', 'replaceAll', 'split', 'localeCompare', 'padStart', 'padEnd', 'concat',
]);

/** Whether this callee is one of those, called as a member (`x.split(…)`). */
function isStringMethod(callee) {
  return !!callee && Array.isArray(callee.path) && callee.path.length >= 1
    && STRING_METHODS.has(callee.path[callee.path.length - 1]);
}

/** What a walk says of a call whose URL was never read: it reaches the client, with nothing known of what it sends. */
const UNREAD_URL = Object.freeze({ reached: true, why: null, methods: [{ value: null, from: 'absent' }] });

/** A sink with nothing to trace: one call, one url, one contract. */
const flatSink = (kind, module) => ({ sink: { kind, module, instance: null, chain: [], depth: 0 }, target: null });

/** The answer for a call that turned out to be no call at all, as distinct from "not one of these". */
const NO_CALL = Object.freeze({ none: true });

/**
 * THE REQUESTS THAT GO THROUGH NO CLIENT AT ALL, and each is a contract rather
 * than a trace:
 *   a transaction   the ONE way a Nexacro client sends a request (RM56), read
 *                   first because that file is also a template
 *   a form submit   `form.action = …; form.submit()` (RM60). Read wherever it
 *                   is written, because the idiom is JavaScript and not markup
 *   the address bar `location.href = …` in a PAGE (RM60): a server-rendered
 *                   page has no router, so the browser fetches the route
 *   a form or link  the markup's own two (RM48)
 *
 * @returns {{sink:object, target:null}|null} null when this call is none of them
 */
function pageSinkOf(c, { isTemplate, resolved, absolute, stats }) {
  if (c.nexacro) {
    stats.calls.nexacro += 1;
    return flatSink('nexacro', 'transaction');
  }
  if (c.websquare) {
    stats.calls.websquare += 1;
    return flatSink('websquare', 'submission');
  }
  if (c.formSubmit) {
    // An action the page fills in whole from an expression (`${url}`) is an
    // address this lane cannot read, which is a different finding from a route.
    if (!urlShaped(absolute, resolved)) { stats.calls.formSubmitsWithoutAddress += 1; return NO_CALL; }
    stats.calls.formSubmits += 1;
    return flatSink('form', FORM_SUBMIT_RULE);
  }
  if (!isTemplate || !c.template || typeof c.template.rule !== 'string') return null;
  if (c.template.rule === LOCATION_REQUEST_RULE) {
    stats.calls.locationRequests += 1;
    return flatSink('location', c.template.rule);
  }
  stats.calls.template += 1;
  return flatSink('template', c.template.rule);
}

/** How a client instance's type was stated, when a field declares it (RM67); nothing otherwise. */
const typedOf = (instance) => (instance && typeof instance.typed === 'string' ? { typed: instance.typed } : {});

/** Which of the six kinds of sink ONE call reached, or null when it is not a call at all. */
function sinkOf(file, c, { resolved, absolute, isTemplate, pkg, deps }) {
  const {
    platformOf, injectedClients, calleeTarget, sinkVerb, wrappers, noteInstance, stats,
  } = deps;
  const platform = platformOf(c);
  const own = pageSinkOf(c, { isTemplate, resolved, absolute, stats });
  if (own !== null) return own === NO_CALL ? null : own;
  if (platform) {
    stats.calls.platform += 1;
    return { sink: { kind: 'platform', module: platform.name, instance: null, chain: [], depth: 0 }, target: null };
  }
  if (c.injected && injectedClients.has(c.injected.client)) {
    // AN INJECTED CLIENT IS A CLIENT. Nothing in the file binds `$http`, so
    // there is nothing to trace: the framework put it in the parameter list,
    // the pack says that parameter is a client, and the worker checked that
    // the function really sits where the framework fills it in.
    stats.calls.injected += 1;
    return { sink: { kind: 'injected', module: c.injected.client, instance: null, chain: [], depth: 0 }, target: null };
  }
  const target = calleeTarget(file, c);
  if (target && target.kind === 'sink' && sinkVerb(target)) {
    noteInstance(target.instance, pkg);
    stats.calls.traced += 1;
    return {
      sink: {
        kind: 'library', module: target.instance.module, instance: target.instance.id ?? null,
        chain: [], depth: 0, ...typedOf(target.instance),
      },
      target,
    };
  }
  if (target !== null && target.kind === 'member' && wrappers.has(target.key)) {
    const via = walkThrough(wrappers, target.key, c, deps.clientKeys, stats);
    // A URL the chain drops is not what the request it makes asks for: no edge.
    // One this lane never read cannot be said to be dropped (review 4, W-6): the
    // call reached the client, and is counted where an unread URL is.
    if (!via.reached && Array.isArray(resolved) && resolved.length > 0) { stats.calls.urlNotHandedOn += 1; return null; }
    stats.calls.traced += 1;
    return { sink: wrapperSink(wrappers, target.key, via.reached ? via : UNREAD_URL), target };
  }
  return untracedSink(c, { resolved, absolute, target, stats });
}

/**
 * The sink a call reaches through a wrapper chain: the deepest hop first, the
 * one the caller named last; what the walk found arrives (the methods, a base
 * URL the request carries); and the step that does not settle it, with why.
 */
function wrapperSink(wrappers, key, via) {
  const chain = [];
  let cur = key;
  for (let i = 0; i < FIXPOINT_LIMIT && cur; i += 1) {
    chain.push(cur);
    cur = wrappers.get(cur)?.next ?? null;
  }
  const w = wrappers.get(key);
  return {
    kind: 'wrapper', module: w.sink.module, instance: w.sink.instance, chain: chain.reverse(), depth: w.depth,
    methods: via.methods, ...(via.base ? { base: via.base } : {}),
    ...(via.why ? { unsettled: { ...via.why, reason: UNSETTLED_BECAUSE[via.why.why] } } : {}),
    ...namedSinkOf(via),
  };
}

/**
 * The step a rule pack named on the way (the edge says which rule and which
 * step), and, where the rule says the step puts a prefix the request options
 * decide before the URL, the rule and those option keys: the call is then
 * placed behind that prefix, not the client's own (prefix.mjs).
 */
function namedSinkOf(via) {
  const m = via.named ? via.named[0] : null;
  if (!m) return {};
  return { hop: { rule: m.rule, step: m.step }, ...(m.prefix ? { hopPrefix: { rule: m.rule, by: m.prefix } } : {}) };
}

/**
 * THE CLIENT INSTANCE A SITE'S PREFIX IS DECIDED FOR: the one it reached, or the
 * package's own when it reached none. Behind a prefix a named step puts before
 * the URL, it is that step's instance of the client: the same client, whose
 * prefix no source here states (prefix.mjs), so it is registered beside it.
 */
function siteInstanceOf(sink, pkg, instanceOf) {
  const own = sink.instance ?? `${pkg}#(package)`;
  if (!instanceOf.has(own)) instanceOf.set(own, { id: own, module: sink.module, baseURL: null, package: pkg });
  const p = sink.hopPrefix;
  if (!p) return own;
  const id = `${own}+${p.rule}`;
  if (!instanceOf.has(id)) {
    instanceOf.set(id, { id, module: sink.module, baseURL: null, package: instanceOf.get(own).package ?? pkg, hop: { rule: p.rule, by: p.by, of: own } });
  }
  return id;
}

/**
 * AN UNTRACED CALL IS ONLY A CALL WHEN ITS ARGUMENT LOOKS LIKE A URL, and when
 * its callee is not one of the methods that take a path apart.
 *
 * The worker records the first argument of any verb-named call as the URL, by
 * the ecosystem's own convention, and that convention is right for
 * `thing.get('/x')` and wrong for `Cookies.get('size')`. Nothing in ONE FILE can
 * tell those apart; the bridge can, because it knows whether the callee reached
 * a client library at all. So a call that reached none AND whose argument is not
 * written like a path is not an HTTP call here: it is counted (`notUrlShaped`)
 * and left alone, rather than becoming a route named `/size` that nothing serves.
 * `pathname.startsWith('/x')` is the other half of the same problem, where the
 * argument IS a path and only the method name says otherwise.
 *
 * @returns {{sink:object, target:(object|null)}|null} null when this is no call
 */
function untracedSink(c, {
  resolved, absolute, target, stats,
}) {
  if (isStringMethod(c.callee)) { stats.calls.stringMethod += 1; return null; }
  if (!urlShaped(absolute, resolved)) { stats.calls.notUrlShaped += 1; return null; }
  stats.calls.untraced += 1;
  countUntraced(stats, c, untracedReasonOf(target));
  return {
    sink: { kind: 'untraced', module: target && target.kind === 'external' ? target.module : null, instance: null, chain: [], depth: 0 },
    target,
  };
}

/**
 * A call with no url at all, counted where it is a request this lane knows
 * happens and cannot follow — which is not the same finding as no request.
 *   a transaction   a Nexacro `transaction(…)` whose url is built elsewhere (RM56)
 *   a submission    a WebSquare submission whose action this lane cannot read (RM63)
 *   a form submit   its own scope assigned no action and its `<form>` element
 *                   names none this lane can read (RM60)
 */
function countAddressless(c, stats) {
  if (c.nexacro) stats.calls.nexacroUnreadable += 1;
  else if (c.websquare) stats.calls.websquareUnreadable += 1;
  else if (c.formSubmit) stats.calls.formSubmitsWithoutAddress += 1;
}

/**
 * What one call's URL IS once the other files have had their say: the
 * constants another module exports and an environment read at its front put
 * in, the host and query taken off text that changed, a page's context path
 * read.
 */
function readCallUrl(file, pkg, c, { ctxVars, constantOf, fill, ports }) {
  // A HOLE ANOTHER MODULE'S CONSTANT EXPLAINS (RM58), filled before anything
  // else reads the template: what this call asks for is decided on the text
  // with the constants in it. A URL that IS such a constant rather than a
  // template with one in it is the same fact (RM59).
  const imported = wholeImportedConstant(file, c, constantOf)
    ?? withImportedConstants(file, pkg, c, c.url.resolved, fill);
  // Only text that CHANGED here needs the host and query taken off it: what
  // the worker resolved has already been through that, and running it again
  // over every call would quietly re-read URLs no constant touched.
  const host = imported.substituted.length === 0
    ? { resolved: imported.resolved, absolute: null } : withoutHost(imported.resolved);
  // A HOST AN ENVIRONMENT READ PUT ON THE FRONT is a base URL's host, not a
  // call to another deployable: whether it is this pack's is what the guess
  // on the site says, the same way it is for a client's base URL.
  const absolute = host.absolute && imported.leadingBase
    ? { ...host.absolute, base: true, ...(imported.away ? { away: imported.away } : {}) }
    : (host.absolute ?? c.url.absolute ?? null);
  return {
    resolved: withContextPath(c, ctxVars, host.resolved),
    absolute,
    substituted: [...(c.url.substituted ?? []), ...imported.substituted],
    assumed: imported.assumed === true,
    // Its own address on this machine, on a port no file states (review 4, W-7).
    guess: imported.guess ?? (absolute && absolute.base !== true ? unsettledPortOf(absolute.host, ports) : null),
    modes: imported.modes ?? null,
  };
}

/**
 * The FIRST of the two passes over the calls: what each call site is, and which
 * URLs each client instance sends.
 *
 * There are two passes because the `auto` prefix has to count matches over the
 * calls of one instance before any of them can be graded.
 *
 * @returns {object[]} one site per call that is an HTTP call
 */
export function classifyCallSites({
  fileNames, files, packageOf, templatesByFile, contextVarsFor, renderedTemplates,
  instanceOf, callsPerInstance, stats, deps,
}) {
  deps = { ...deps, clientKeys: makeClientKeys(deps) };
  const methodsFor = makeMethodsFor(deps);
  const constantOf = makeConstantOf({ files, resolver: deps.resolver });
  const fill = makeHoleFiller({ constantOf, configFor: deps.configFor, ports: deps.ports ?? null });
  const sites = [];
  for (const file of fileNames) {
    const f = files.get(file);
    const pkg = packageOf(file);
    const isTemplate = templatesByFile.has(file);
    const ctxVars = isTemplate ? contextVarsFor(file) : null;
    // A TEMPLATE NOBODY RENDERS IS DEAD MARKUP. Its links go somewhere, but
    // nobody opens them, so they are not this application's calls.
    if (isTemplate && !renderedTemplates.has(file)) {
      stats.templates.unrendered += 1;
      continue;
    }
    for (const c of f.calls) {
      if (!c.url) { countAddressless(c, stats); continue; }
      const u = readCallUrl(file, pkg, c, { ctxVars, constantOf, fill, ports: deps.ports ?? null });
      const { resolved, absolute, substituted } = u;
      const found = sinkOf(file, c, { resolved, absolute, isTemplate, pkg, deps });
      if (found === null) continue;
      const { sink, target } = found;
      stats.calls.withUrl += 1;
      countUrlCensus(stats, resolved, substituted, u.guess);
      const instanceId = siteInstanceOf(sink, pkg, instanceOf);
      sites.push({
        file, pkg, call: c, target, instanceId, ...methodsAndBase(c, sink, methodsFor(c, sink, target), deps.clientKeys),
        assumed: (target && target.assumed === true) || u.assumed,
        template: isTemplate, resolved, absolute,
        ...(substituted.length > 0 ? { substituted } : {}),
        ...(u.guess ? { guess: u.guess } : {}), ...(u.modes ? { buildModes: u.modes } : {}),
      });
      if (Array.isArray(resolved) && !isTemplate) {
        if (!callsPerInstance.has(instanceId)) callsPerInstance.set(instanceId, []);
        for (const r of resolved) callsPerInstance.get(instanceId).push(r.template);
      }
    }
  }
  return sites;
}

/**
 * WHAT A SITE SENDS BESIDES ITS URL: its method, every other one a wrapper
 * chain may send (`methods`), and a base URL the request carries of its own
 * (review 3, R3): one a wrapper step or the caller wrote (the walk found it),
 * or one a call on a client writes into its options. One that is not a path
 * this lane can read leaves the call's base unsettled, and the edge says so.
 */
function methodsAndBase(c, sink, methods, clientKeys) {
  const out = { sink, method: methods[0], ...(methods.length > 1 ? { methods } : {}) };
  if (sink.kind === 'wrapper') return sink.base ? { ...out, requestBase: sink.base } : out;
  const key = sink.kind === 'library' ? clientKeys(sink).base : null;
  const at = c.url && c.url.at ? c.url.at : null;
  const a = key && at ? (c.args ?? [])[typeof at.key === 'string' ? at.arg : at.arg + 1] : null;
  const v = a && a.kind === 'object' && a.keys ? a.keys[key] : undefined;
  if (v === undefined) return out;
  if (v && v.kind === 'string' && v.value.startsWith('/')) return { ...out, requestBase: v.value };
  return { ...out, sink: { ...sink, unsettled: { hop: null, why: 'request-base', key, reason: UNSETTLED_BECAUSE['request-base'] } } };
}

/**
 * The path this call really asks the server for, and the evidence for it.
 *
 * A declared gateway route rewrites the CALL, not just the client: a project
 * whose calls carry the dev prefix has nowhere else to say so. The template is
 * normalized BEFORE the prefix is joined on, or a path written without its
 * leading slash (`get('user/list')`) would be glued to the prefix as
 * `/adminuser/list`.
 */
function fullUrlOf(written, { prefix, absolute, gatewayRoutes, gatewayKeys }) {
  let full = absolute !== null
    ? normalizeUrl(written)
    : normalizeUrl(`${prefix.value}${normalizeUrl(written)}`);
  // What the base URL rested on, and which build gave which value, only when
  // there is something to say (prefix.mjs): a plain base URL's evidence is
  // what it always was.
  let prefixEvidence = {
    value: prefix.value, from: prefix.from,
    ...(prefix.guess ? { guess: prefix.guess } : {}), ...(prefix.reads ? { reads: prefix.reads } : {}),
    ...(prefix.hop ? { hop: prefix.hop } : {}),
  };
  // WHICH SERVICE ANSWERS THIS CALL, when the declared route names one. A
  // gateway route table says both halves — the prefix a request is forwarded
  // with, and the deployable it is forwarded to — and the second half is what
  // lets an answer cross into the right sibling when several serve the same
  // path (src/mcp/federation.mjs).
  let declaredService = prefix.from === 'declared' ? (prefix.service ?? null) : null;
  if (prefix.from !== 'declared') {
    const hit = gatewayKeys.find((k) => full === k || full.startsWith(`${k}/`));
    if (hit !== undefined) {
      const route = gatewayRouteOf(gatewayRoutes[hit]);
      full = normalizeUrl(`${route.to}${full.slice(hit.length)}`);
      prefixEvidence = { value: route.to, from: 'declared' };
      declaredService = route.service;
    }
  }
  if (prefix.from === 'auto') prefixEvidence.candidates = prefix.candidates;
  return { full, prefixEvidence, declaredService };
}

/** The node for the function this call is written in, added the first time it is seen. */
function noteCaller(site, nodesToAdd, files) {
  const { file, call } = site;
  const enclosing = call.enclosing ?? '(module)';
  const fromId = webSymbolId(file, enclosing);
  const fnRec = files.get(file)?.functions.get(enclosing) ?? null;
  nodesToAdd.set(fromId, {
    id: fromId, symbol: `${file}#${enclosing}`, file, line: fnRec ? fnRec.line : (call.line ?? null),
    lane: 'web', exported: fnRec ? (fnRec.exported ?? null) : null,
    ...(isComponentFile(file, files.get(file) ?? null) ? { component: true } : {}),
  });
  return fromId;
}

/** What an edge says about the sink its call reached, and the wrapper step that leaves the URL unsettled. */
function sinkEvidence(sink) {
  return {
    kind: sink.kind, module: sink.module, instance: sink.instance, chain: sink.chain, depth: sink.depth, ...typedOf(sink),
    ...(sink.unsettled ? { unsettled: sink.unsettled } : {}), ...(sink.hop ? { hop: sink.hop } : {}),
  };
}

/** Everything an edge from this call site says about itself. */
function callEvidence(site, {
  written, full, via, absolute, prefixEvidence, declaredService, found, away = null,
}) {
  const { call, sink } = site;
  const evidence = {
    rule: call.nexacro ? 'nexacro-transaction'
      : call.websquare ? SUBMISSION_RULE
      : call.formSubmit ? FORM_SUBMIT_RULE
        : site.template && call.template ? call.template.rule : 'web-http-call',
    ...(call.nexacro ? { nexacro: call.nexacro } : {}),
    ...(call.websquare ? { websquare: call.websquare } : {}),
    basis: sink.typed ? WEB_CALL_BASIS.typed : WEB_CALL_BASIS[sink.kind],
    // WHICH FORM, AND WHERE THE METHOD CAME FROM (RM60). A page has a dozen
    // forms and a reader checking this edge needs to know which one was
    // submitted, and whether the method was assigned, read off the `<form>`
    // element, or never found at all.
    ...(call.formSubmit ? { form: call.formSubmit } : {}),
    ...(site.template && call.template ? { attribute: call.template.attr, wrote: call.template.written } : {}),
    sink: sinkEvidence(sink),
    // `written` is the path as the code spells it, `template` the path this
    // pack was searched for. An absolute URL keeps its HOST here, because
    // the node id is a path and two hosts would otherwise be one node.
    url: {
      written, template: full, via,
      ...(absolute ? { host: absolute.host } : {}),
      // WHAT WAS PUT INTO THE PATH (RM58): each constant this call's URL was
      // built on, and where its literal was read. `written` is the path with
      // them already in it, so this is how a reader gets back to the source.
      ...(site.substituted ? { substituted: site.substituted } : {}),
      // What the front of the URL rests on when an environment read put it
      // there: a default literal, or a host that is not this machine.
      ...(site.guess ? { guess: site.guess } : {}),
    },
    method: site.method,
    prefix: prefixEvidence,
    // The same two fields the Java lane puts on a call it read a host from
    // (src/adapters/java_bridge.mjs): the service this call is for, and
    // whether that name was WRITTEN somewhere rather than inferred. Here it
    // was written, in the gateway's own route table.
    ...(declaredService ? { service: declaredService, serviceLiteral: true } : {}),
    match: found.how,
    target: found.routes.length > 0 ? 'in-pack' : 'outside-pack',
    // WHY IT LEFT: this machine, but a port another service listens on.
    ...(away ? { away } : {}),
  };
  if (site.assumed) evidence.alias = 'assumed';
  return evidence;
}

/** A base URL the request carries of its own, which a client puts in place of its instance's. */
function requestPrefix(site) {
  return typeof site.requestBase === 'string' ? { value: normalizeUrl(site.requestBase), from: 'request' } : null;
}

/**
 * ONE URL CANDIDATE of one call site, placed.
 *
 * A ternary URL is TWO possible requests from one call site: each gets its own
 * edge, and the site's own census below counts the call once, at the weaker
 * grade of whatever its candidates reached. Counting edges instead would make
 * "calls resolved" bigger than "calls".
 *
 * @returns {{how:(string|null), routes:number, grade:(string|null)}} what this
 *          candidate reached, for the site's census to fold in.
 */
function placeCandidate(cand, site, ctx) {
  const {
    g, files, nodesToAdd, edges, stats, matchUrl, gatewayRoutes, gatewayKeys,
    prefix, absolute, outsidePack, unmatched, httpFunctionIds, matchedRoutePaths,
  } = ctx;
  const written = cand.template;
  if (!namesARoute(written)) return { how: null, routes: 0, grade: null, allHoles: true };
  const { full, prefixEvidence, declaredService } = fullUrlOf(written, {
    prefix, absolute, gatewayRoutes, gatewayKeys,
  });
  const found = outsidePack ? { how: null, routes: [] } : matchUrl(full, site.method.value);
  let grade = site.sink.kind === 'untraced' ? 'HEURISTIC' : 'SOUND_SET';
  // NOTHING RISES ABOVE SOUND_SET ON A CALL, a page's form included: which
  // handler answers a path is the route table's answer, not the markup's.
  if (prefixEvidence.from === 'auto' || site.assumed || site.method.value === null) grade = 'HEURISTIC';
  // A base URL that rests on a default literal or a deployment's host
  // (base_url.mjs), or a wrapper step that may or may not hand the URL on.
  if (prefixEvidence.guess || site.guess || site.sink.unsettled) grade = 'HEURISTIC';

  const fromId = noteCaller(site, nodesToAdd, files);
  httpFunctionIds.add(fromId);
  const evidence = callEvidence(site, {
    written, full, via: cand.via ?? null, absolute, prefixEvidence, declaredService, found, away: ctx.away,
  });

  if (found.routes.length === 0) {
    const httpMethod = site.method.value ?? 'ANY';
    const epId = webEndpointId(httpMethod, full);
    if (!g.nodes.has(epId) && !nodesToAdd.has(epId)) {
      nodesToAdd.set(epId, { id: epId, path: full, httpMethod, outbound: true, source: 'web' });
      stats.outboundEndpoints += 1;
    }
    edges.push({ from: fromId, to: epId, type: 'CALLS_HTTP', grade: 'UNRESOLVED', evidence });
    const key = `${httpMethod} ${full}`;
    unmatched.set(key, (unmatched.get(key) ?? 0) + 1);
    return { how: null, routes: 0, grade: null, missed: true };
  }
  const placed = placeRouteEdges(found, { fromId, grade, evidence, edges, matchedRoutePaths });
  return { how: found.how, routes: placed.routes, grade: placed.grade };
}

/**
 * One CALLS_HTTP edge per route a candidate matched, each graded by the call
 * and by what the route itself cannot settle: its own address (a lane's doubt,
 * `address`), and a catch-all a more specific route may shadow under a prefix
 * set in code (`catchAll`, with the routes that drop finds, `prefixShift`).
 *
 * @returns {{routes:number, grade:string}} how many edges, and the weakest grade placed
 */
function placeRouteEdges(found, { fromId, grade, evidence, edges, matchedRoutePaths }) {
  const shifted = found.shifted ? found.shifted.routes.map((r) => ({ r, shift: true })) : [];
  const all = [...found.routes.map((r) => ({ r, shift: false })), ...shifted].sort((a, b) => cmp(a.r.id, b.r.id));
  let weakest = grade;
  for (const { r, shift } of all) {
    matchedRoutePaths.add(r.path);
    let g = found.unsettled ? 'HEURISTIC' : grade;
    if (r.address && GRADE_RANK[r.address.grade] < GRADE_RANK[g]) g = r.address.grade;
    if (GRADE_RANK[g] < GRADE_RANK[weakest]) weakest = g;
    const ev = { ...evidence, ...(all.length > 1 ? { candidates: all.length } : {}) };
    if (r.address) ev.address = r.address.why;
    if (found.unsettled && !shift) ev.catchAll = { unsettled: found.unsettled };
    if (shift) Object.assign(ev, { match: `${found.shifted.how}-shifted`, prefixShift: { dropped: found.shifted.dropped, unsettled: found.unsettled } });
    edges.push({ from: fromId, to: r.id, type: 'CALLS_HTTP', grade: g, evidence: ev });
  }
  return { routes: all.length, grade: weakest };
}

/** What ONE call site, all its candidates folded together, counts as. */
function countSite(site, seen, { stats, unmatched, prefix, outsidePack }) {
  if (seen.grade !== null) {
    stats.resolved[seen.grade] += 1;
    if (seen.match === 'exact') stats.matches.exact += 1; else stats.matches.template += 1;
    if (seen.multi) stats.matches.multi += 1;
    return;
  }
  if (seen.missed) {
    stats.unresolved.total += 1;
    stats.unresolved.byReason[outsidePack ? 'outsidePack' : 'noMatch'] += 1;
    return;
  }
  if (seen.allHoles) {
    stats.unresolved.total += 1;
    stats.unresolved.byReason.allHoles += 1;
    const key = `${site.method.value ?? 'ANY'} ${normalizeUrl(`${prefix.value}${normalizeUrl(site.resolved[0].template)}`)}`;
    unmatched.set(key, (unmatched.get(key) ?? 0) + 1);
  }
}

/**
 * Whether an absolute URL names ANOTHER deployable. This machine is not one,
 * whatever port it names: that is a backend's development server
 * (packs/build-env.json `localHosts`). A host a dev-proxy rule forwards to is
 * where this frontend's own requests go. And a host an environment read put on
 * the front is a base URL's, which the site's guess grades instead of sending
 * the call out of the pack, exactly as a client's base URL is graded.
 */
function leavesThePack(absolute, cfg) {
  if (absolute === null || absolute.base === true || isLocalHost(absolute.host)) return false;
  return !cfg.proxies.some((p) => typeof p.target === 'string' && p.target.includes(absolute.host));
}

/**
 * NO BUILD SENDS IT (review 2, item 4): the builds the client's base URL holds
 * in and the builds the front of the path holds in share none, so the two are
 * never one request.
 */
function noBuildSendsIt(site, prefix) {
  if (!Array.isArray(site.buildModes) || !Array.isArray(prefix.modes)) return false;
  return !site.buildModes.some((m) => prefix.modes.includes(m));
}

/**
 * THE BASE URL EACH BUILD PUTS IN FRONT (review 3, R4): the client's, and, when
 * some builds set it nowhere, the empty one those builds send the path with.
 * Each is a candidate for the builds it holds in, never one for every build.
 */
function prefixesByBuild(prefix) {
  if (!prefix.unset || prefix.unset.value === prefix.value) return [prefix];
  return [prefix, { value: prefix.unset.value, from: prefix.from, candidates: [], modes: prefix.unset.modes, front: '' }];
}

/** One site's candidates placed behind ONE base URL, every method it may send; whether they left the pack. */
function placeSite(site, prefix, seen, shared) {
  const { stats, ports, configFor } = shared;
  const absolute = site.absolute ?? site.call.url.absolute ?? null;
  const away = awayOfSite(prefix, absolute, ports);
  const outsidePack = away !== null || leavesThePack(absolute, configFor(site.pkg));
  if (away !== null && stats.ports) stats.ports.otherPortCalls += 1;
  const ctx = { ...shared, prefix, absolute, outsidePack, away };
  for (const [cand, one] of site.resolved.flatMap((x) => (site.methods ?? [site.method]).map((m) => [x, { ...site, method: m }]))) {
    const got = placeCandidate(cand, one, ctx);
    if (got.allHoles) { seen.allHoles = true; continue; }
    if (got.missed) { seen.missed = true; continue; }
    if (got.routes > 1) seen.multi = true;
    if (seen.match === null || (seen.match === 'template' && got.how === 'exact')) seen.match = got.how;
    if (seen.grade === null || GRADE_RANK[got.grade] < GRADE_RANK[seen.grade]) seen.grade = got.grade;
  }
  return outsidePack;
}

/**
 * THIS MACHINE, ANOTHER SERVICE: where the call goes to this machine on a port
 * no application of this pack listens on (base_url.mjs otherPortOf), through
 * its client's base URL, the base URL at its front, or its own address. Null
 * when it does not, or when the pack's ports are not known.
 */
function awayOfSite(prefix, absolute, ports) {
  if (prefix.away) return prefix.away;
  if (absolute === null) return null;
  if (absolute.base === true) return absolute.away ?? null;
  return otherPortOf(absolute.host, ports);
}

/**
 * The SECOND pass: one CALLS_HTTP edge per (call candidate, route it matched),
 * and an outbound endpoint node for a URL nothing here answers.
 *
 * @returns {{httpFunctionIds:Set<string>, matchedRoutePaths:Set<string>, unmatched:Map}}
 */
export function placeHttpEdges({
  sites, g, files, nodesToAdd, edges, stats, prefixOf, matchUrl, configFor,
  gatewayRoutes, gatewayKeys, ports = null,
}) {
  // The URL never resolved: no edge at all, counted by the reason the worker gave.
  const REASON = { parameter: 'parameter', expression: 'expression', 'imported-constant': 'importedConstant' };
  const unmatched = new Map();
  // The functions that SEND a request, and the routes their calls landed on.
  // Both are read by the screen axis: the first seeds the fixpoint that decides
  // which functions get a node, the second answers "does this frontend ask the
  // server for its own menu?".
  const httpFunctionIds = new Set();
  const matchedRoutePaths = new Set();
  const shared = {
    g, files, nodesToAdd, edges, stats, matchUrl, gatewayRoutes, gatewayKeys, unmatched, httpFunctionIds, matchedRoutePaths, ports, configFor,
  };

  for (const site of sites) {
    const { call } = site;
    if (!Array.isArray(site.resolved) || site.resolved.length === 0) {
      const reason = REASON[call.url.unresolved] ?? 'expression';
      stats.unresolved.total += 1;
      stats.unresolved.byReason[reason] += 1;
      continue;
    }
    // A PAGE'S URLS ARE WRITTEN FROM THE APP ROOT. `${request.contextPath}`,
    // `@{/…}` and `<c:url>` all mean "where this deployment is mounted", which
    // is not part of any route the pack serves, so the prefix is the empty
    // string and nothing had to be guessed to know that.
    const prefixes = prefixesByBuild(site.template ? TEMPLATE_PREFIX : requestPrefix(site) ?? prefixOf(site.instanceId))
      .filter((p) => !noBuildSendsIt(site, p));
    if (prefixes.length === 0) {
      stats.unresolved.total += 1;
      stats.unresolved.byReason.noBuild += 1;
      continue;
    }
    const seen = { grade: null, match: null, multi: false, missed: false, allHoles: false };
    let outsidePack = false;
    for (const prefix of prefixes) outsidePack = placeSite(site, prefix, seen, shared) || outsidePack;
    countSite(site, seen, { stats, unmatched, prefix: prefixes[0], outsidePack });
  }
  return { httpFunctionIds, matchedRoutePaths, unmatched };
}

// ---------------------------------------------------------------------------
// B7a: `frontend function --CALLS--> frontend function`
//
// WHAT RESOLVES, and what each answer is graded:
//   EXACT      a static import with a named or default specifier, followed
//              through a relative path or a DECLARED alias to a `function`
//              record in a file this lane parsed; or a call by name inside
//              one file (`getList()`, `this.getList()`), where the name can
//              only mean the declaration beside it
//   SOUND_SET  the same, but the name came through an `export *` barrel or a
//              re-export chain, so WHICH file it really comes from was a
//              choice this lane made and disclosed
//   HEURISTIC  an ASSUMED alias was on the path, so the file it resolved to
//              rests on a guess
//
// AND A FUNCTION THAT IS NEVER CALLED HERE AT ALL (RM32). A view that writes
// `usePagedList({ api: list })` hands `list` over as a VALUE: no call site
// names it, so every rule above sees nothing and the screen ends there. The
// worker records what was passed (`fnRefs`); this section resolves it exactly
// as it resolves a callee, and the edge is SOUND_SET, never EXACT: whether
// the receiver ever calls what it was given is not something this lane
// looked at, and it does not pretend otherwise. An assumed alias on the path
// lowers it to HEURISTIC, the same as everywhere else.
//
// AND A MEMBER OF AN IMPORTED OBJECT (RM57). `export const contentService = {
// get: … }` in one file and `contentService.get(id)` in another is one hop, the
// same as a bare call, and it is how most TypeScript frontends keep their API
// calls. The worker records whose each function is, so the member is resolved
// by name rather than guessed at by looking for any function spelled `get` in
// that file. A member call that lands on something this lane never read
// (`client.get(...)`, where `client` is a client instance) is still no edge and
// still not counted as a miss: the HTTP pass above already explained it.
// ---------------------------------------------------------------------------

/**
 * THE FUNCTION AN IMPORT LEADS TO, for a bare call and for a member call alike.
 *
 * A bare call (`listRows()`) names the export itself. A MEMBER call
 * (`rowService.listRows()`) names one function written inside the object the
 * export is — which is how most TypeScript frontends keep their API calls. The
 * worker recorded whose each of those functions is, so the member is looked up
 * by name rather than guessed at by finding any function spelled `listRows` in
 * that file. Anything deeper (`a.b.c()`) is a path through objects nobody
 * recorded, and is refused.
 *
 * `fn` is null when the import resolved and what it landed on is not a function
 * this lane read; the whole answer is null when it did not resolve at all.
 */
function importedFunctionOf({ files, members, resolveSpecifier, resolveExport }, file, imp, parts) {
  const namespace = imp.imported === '*';
  const member = !namespace && parts.length === 1 ? parts[0] : null;
  if (namespace ? parts.length !== 1 : parts.length > 1) return null;
  const r = resolveSpecifier(file, imp.source);
  if (!r.file) return null;
  const hit = resolveExport(r.file, namespace ? parts[0] : imp.imported, 0);
  if (!hit || hit.external || !hit.file) return null;
  const fn = member === null
    ? (files.get(hit.file)?.functions.get(hit.name) ?? null)
    : (members.get(`${hit.file}#${hit.name}.${member}`) ?? null);
  return { hit, member, fn, assumedAlias: r.assumed === true };
}

/** What one resolved import says about itself, with every qualifier that applies. */
function importEvidence(specifier, found, assumed) {
  const { hit, member, fn } = found;
  const evidence = { rule: 'esm-import', specifier, origin: `${hit.file}#${fn.name}` };
  if (member !== null) evidence.member = `${hit.name}.${member}`;
  if (hit.viaStar === true) evidence.viaStar = true;
  if (assumed) evidence.assumedAlias = true;
  return evidence;
}

/**
 * `this.orders.list()` THROUGH A FIELD WHOSE TYPE THE CLASS STATES (RM67): the
 * method of the class that type names, when this lane read it. SOUND_SET and
 * never EXACT, the TypeScript lane's grade for the same call, because a
 * subclass may override the method and the provider bound to the type may be
 * another class; an assumed alias on the way to the type lowers it to
 * HEURISTIC. A field the class assigns itself (`this.x = new X()`) is not this
 * rule's, and neither is a client: the HTTP pass already explained that one.
 */
function typedFieldTarget({ files, resolver, providersOf }, file, className, parts) {
  const v = resolver.fieldValue(file, className, parts[0], 0);
  if (!v || v.kind !== 'class-instance' || typeof v.typed !== 'string') return null;
  const behind = providersOf(v.key);
  const declared = behind.classes.map((key) => declaringClass(files, resolver, key, parts[1]));
  const found = [];
  for (const t of declared) if (t !== null && !found.some((x) => x.file === t.file && x.type === t.type)) found.push({ ...t, name: `${t.type}.${parts[1]}` });
  if (found.length === 0) return null;
  const assumed = v.assumed === true;
  // A candidate set a provider this lane does not read may add to, or with a
  // class whose method this lane did not find, is not one guaranteed to hold
  // the truth (review 2, item 6; review 3, N1).
  const grade = assumed || behind.unread.length > 0 || declared.includes(null) ? 'HEURISTIC' : 'SOUND_SET';
  const providers = behind.providers.length > 0 || behind.unread.length > 0
    ? { providers: { candidates: found.map((t) => `${t.file}#${t.name}`), ...(behind.unread.length > 0 ? { unread: behind.unread } : {}) } }
    : {};
  const [first, ...rest] = found.map((t) => ({
    file: t.file,
    name: t.name,
    grade,
    evidence: {
      rule: 'typed-field', field: parts[0], type: t.type, via: v.typed, origin: `${t.file}#${t.name}`,
      ...(v.viaStar === true ? { viaStar: true } : {}), ...(assumed ? { assumedAlias: true } : {}), ...providers,
    },
  }));
  return rest.length > 0 ? { ...first, also: rest } : first;
}

/**
 * THE CLASS WHOSE METHOD AN INSTANCE RUNS (review 3, N1): the class itself when
 * it declares the method, else the nearest class up what it extends that
 * does. Null when none this lane read does.
 */
function declaringClass(files, resolver, key, method) {
  for (let cur = key, i = 0; cur && i < 8; i += 1) {
    const at = cur.lastIndexOf('#');
    const file = cur.slice(0, at);
    const type = cur.slice(at + 1);
    const f = files.get(file);
    if (f && f.functions.has(`${type}.${method}`)) return { file, type };
    const ext = f ? f.classes.get(type)?.extends : null;
    const up = ext ? resolver.rootValue(file, ext.callee, ext.binding ?? null, 0) : null;
    cur = up && up.kind === 'class' ? up.key : null;
  }
  return null;
}

/**
 * WHAT THE PROVIDERS IN THE TREE PUT BEHIND A TOKEN (review 2, item 6), for a
 * field whose type is that token: the class itself, every class a `useClass`
 * names, and what a `useExisting` token has behind it in turn. Which injector
 * serves the field (a component's, a module's, the application's) is not read,
 * so every provider in the tree is a candidate. A factory, a value, or a class
 * this lane did not read is `unread`: the set may then be short.
 */
function makeProvidersOf({ files, resolver }) {
  const byToken = new Map();
  for (const [file, f] of files) {
    for (const p of f.providers ?? []) {
      const token = resolver.rootValue(file, p.token.callee, p.token.binding ?? null, 0);
      if (!token || token.kind !== 'class') continue;
      const target = p.target ? resolver.rootValue(file, p.target.callee, p.target.binding ?? null, 0) : null;
      if (!byToken.has(token.key)) byToken.set(token.key, []);
      byToken.get(token.key).push({
        use: p.use, via: p.via, file, line: p.line, target: target && target.kind === 'class' ? target.key : null,
      });
    }
  }
  const expand = (key, out, seen) => {
    if (seen.has(key)) return;
    seen.add(key);
    out.classes.push(key);
    for (const p of byToken.get(key) ?? []) {
      out.providers.push(p);
      if (p.use === 'unread' || p.target === null) out.unread.push({ use: p.via, file: p.file, line: p.line });
      else if (p.use === 'existing') expand(p.target, out, seen);
      else if (!out.classes.includes(p.target)) out.classes.push(p.target);
    }
  };
  return (key) => {
    const out = { classes: [], providers: [], unread: [] };
    expand(key, out, new Set());
    return out;
  };
}

/** What one call NAMES, when it names a function this lane read. */
function makeCallTargetOf({ files, members, resolver, httpSiteCalls, stats, providersOf }) {
  const { resolveSpecifier, resolveExport } = resolver;
  return (file, c) => {
    const callee = c.callee ?? null;
    if (!callee || typeof callee.root !== 'string') return null;
    // `new Thing()` builds a value; it is not the hop from a screen to the
    // function that fetches its data, which is what this section is about.
    if (callee.shape === 'new') return null;
    const parts = callee.path ?? [];
    const binding = c.binding ?? null;
    const f = files.get(file);
    if (!f) return null;
    const sameFile = (name) => ({
      file, name, grade: 'EXACT', evidence: { rule: 'same-file', origin: `${file}#${name}` },
    });
    // `this.getList()` inside a class: the member is a function of THIS file,
    // recorded under `<Class>.<name>`.
    if (binding && binding.kind === 'this') {
      if (typeof binding.class !== 'string') return null;
      if (parts.length === 2) return typedFieldTarget({ files, resolver, providersOf }, file, binding.class, parts);
      if (parts.length !== 1) return null;
      const name = `${binding.class}.${parts[0]}`;
      return f.functions.has(name) ? sameFile(name) : null;
    }
    const imp = f.importOf.get(callee.root);
    if (!imp) {
      // A name this file declares, called by name. Only a bare call: a member
      // path on a local object is not a function this lane can name.
      if (parts.length !== 0) return null;
      return f.functions.has(callee.root) ? sameFile(callee.root) : null;
    }
    const found = importedFunctionOf({ files, members, resolveSpecifier, resolveExport }, file, imp, parts);
    if (found === null) return null; // a package this analysis never read
    if (found.fn === null) {
      // It resolved, and what it landed on is not a function: a constant, a
      // component, a client. No edge, and a number rather than a silence —
      // except where the HTTP pass above already explained this call, because a
      // call onto a client instance is not a missing hop, it is the sink. A
      // MEMBER that landed on nothing is that same sink, so it is not a miss
      // either and was never counted as one.
      if (found.member === null && !httpSiteCalls.has(c)) stats.calls.notAFunction += 1;
      return null;
    }
    const assumed = found.hit.assumed === true || found.assumedAlias;
    const grade = assumed ? 'HEURISTIC' : found.hit.viaStar === true ? 'SOUND_SET' : 'EXACT';
    return {
      file: found.hit.file, name: found.fn.name, grade,
      evidence: importEvidence(imp.source, found, assumed),
    };
  };
}

/**
 * The function one `fnRefs` entry names, resolved the way a callee is.
 *
 * Nothing about the RECEIVER is inspected: this rule does not ask whether
 * `usePagedList` calls its `api`, because answering that would mean following
 * a value into another module's body, and a lane that guessed at it would be
 * guessing on every hook in the ecosystem. What is stated instead is what the
 * source states: this function was handed over here, so whoever took it may
 * call it. That is a sound candidate, and SOUND_SET is what it is graded.
 */
function makeFnRefTargetOf({ files, members, resolver }) {
  const { resolveSpecifier, resolveExport } = resolver;
  return (file, ref) => {
    if (!ref || typeof ref.name !== 'string') return null;
    const f = files.get(file);
    if (!f) return null;
    const parts = Array.isArray(ref.path) ? ref.path : [];
    const via = ref.via === 'property' ? 'property' : 'argument';
    const keyPart = typeof ref.key === 'string' ? { key: ref.key } : {};
    const imp = f.importOf.get(ref.name);
    if (!imp) {
      // A name this file declares. Only a bare name: a member of a local object
      // is not a function this lane can put a symbol on.
      if (parts.length !== 0 || !f.functions.has(ref.name)) return null;
      return {
        file,
        name: ref.name,
        grade: 'SOUND_SET',
        evidence: { rule: 'passed-as-value', via, ...keyPart, origin: `${file}#${ref.name}` },
      };
    }
    // THE SAME INDEX A CALLEE GOES THROUGH (RM58). `usePagedList({ api:
    // boardService.getPosts })` hands over a function written inside an
    // imported object, which is the same hop as calling it, so it is resolved
    // by the same rule rather than refused for having a dot in it.
    const found = importedFunctionOf({ files, members, resolveSpecifier, resolveExport }, file, imp, parts);
    // What was passed is not a function this lane read: a constant, a component,
    // a client instance. Handing one of those over is ordinary, and it is not a
    // missing hop, so it is not counted as one either.
    if (found === null || found.fn === null) return null;
    const { hit, member, fn } = found;
    const assumed = hit.assumed === true || found.assumedAlias;
    const evidence = {
      rule: 'passed-as-value', via, ...keyPart, specifier: imp.source, origin: `${hit.file}#${fn.name}`,
      ...(member === null ? {} : { member: `${hit.name}.${member}` }),
    };
    if (hit.viaStar === true) evidence.viaStar = true;
    if (assumed) evidence.assumedAlias = true;
    return { file: hit.file, name: fn.name, grade: assumed ? 'HEURISTIC' : 'SOUND_SET', evidence };
  };
}

/**
 * THE FUNCTION-CREATION RULE. Only a function that sends a request, or that
 * reaches one through these edges, becomes a node. Everything else — the
 * formatters, the validators, the date helpers — is counted and left out, or
 * the pack doubles in size for code no question is ever about.
 */
function functionsReachingHttp(callCandidates, httpFunctionIds) {
  const callersOf = new Map();
  for (const e of callCandidates.values()) {
    let arr = callersOf.get(e.to);
    if (!arr) callersOf.set(e.to, arr = []);
    arr.push(e.from);
  }
  const reachingHttp = new Set(httpFunctionIds);
  const queue = [...httpFunctionIds];
  while (queue.length > 0) {
    const id = queue.shift();
    for (const from of callersOf.get(id) ?? []) {
      if (reachingHttp.has(from)) continue;
      reachingHttp.add(from);
      queue.push(from);
    }
  }
  return reachingHttp;
}

/**
 * Every `function --CALLS--> function` pair this lane can name, with the first
 * answer for a pair kept: two calls to the same target from the same function
 * are ONE edge, and the records are in line order, so the first one wins.
 */
function collectCallPairs({ fileNames, files, callTargetOf, fnRefTargetOf, stats, symbolMeta }) {
  const callCandidates = new Map(); // `${from}|${to}` -> {from, to, grade, evidence}
  const remember = (fromFile, fromName, t) => {
    const fromId = webSymbolId(fromFile, fromName);
    const toId = webSymbolId(t.file, t.name);
    if (fromId === toId) return; // a function calling (or handing over) itself is not a hop
    symbolMeta.set(fromId, { file: fromFile, name: fromName });
    symbolMeta.set(toId, { file: t.file, name: t.name });
    const key = `${fromId}|${toId}`;
    if (!callCandidates.has(key)) {
      callCandidates.set(key, { from: fromId, to: toId, grade: t.grade, evidence: t.evidence });
    }
  };
  for (const file of fileNames) {
    for (const c of files.get(file).calls) {
      const t = callTargetOf(file, c);
      if (!t) continue;
      remember(file, c.enclosing ?? '(module)', t);
      // Every class a provider may put behind a typed field is a candidate too.
      for (const also of t.also ?? []) remember(file, c.enclosing ?? '(module)', also);
    }
  }
  // A SECOND PASS, after every call has had its say. A pair that is both CALLED
  // and PASSED keeps the call's answer, which is the stronger of the two: a
  // view that writes `list()` beside `usePagedList({ api: list })` gets one
  // EXACT edge, not a SOUND_SET one that happened to be seen first.
  for (const file of fileNames) {
    for (const c of files.get(file).calls) {
      for (const ref of c.fnRefs ?? []) {
        const t = fnRefTargetOf(file, ref);
        if (!t) continue;
        stats.calls.passedAsValue += 1;
        remember(file, c.enclosing ?? '(module)', t);
      }
    }
  }
  return callCandidates;
}

/** The web symbol ids of every node this lane created, grouped by their file. */
function symbolsPerFile(nodesToAdd) {
  const symbolsByFile = new Map();
  for (const [id, n] of nodesToAdd) {
    if (n.lane !== 'web' || typeof n.file !== 'string') continue;
    let arr = symbolsByFile.get(n.file);
    if (!arr) symbolsByFile.set(n.file, arr = []);
    arr.push(id);
  }
  for (const arr of symbolsByFile.values()) arr.sort();
  return symbolsByFile;
}

/**
 * B7a: the calls BETWEEN frontend functions, and the nodes they justify.
 * @returns {{symbolsByFile:Map}} the web symbol ids per file, which the screen
 *          axis hangs its RENDERS edges off.
 */
export function linkFrontendCalls({
  fileNames, files, resolver, sites, nodesToAdd, edges, stats, httpFunctionIds,
}) {
  const httpSiteCalls = new Set(sites.map((s) => s.call));
  const members = memberIndex(files);
  const callTargetOf = makeCallTargetOf({
    files, members, resolver, httpSiteCalls, stats, providersOf: makeProvidersOf({ files, resolver }),
  });
  const fnRefTargetOf = makeFnRefTargetOf({ files, members, resolver });

  const symbolMeta = new Map(); // symbol node id -> {file, name}
  for (const [id, n] of nodesToAdd) {
    if (n.lane === 'web') symbolMeta.set(id, { file: n.file, name: String(n.symbol).slice(String(n.symbol).indexOf('#') + 1) });
  }
  const callCandidates = collectCallPairs({
    fileNames, files, callTargetOf, fnRefTargetOf, stats, symbolMeta,
  });

  const reachingHttp = functionsReachingHttp(callCandidates, httpFunctionIds);
  for (const id of [...reachingHttp].sort()) {
    if (nodesToAdd.has(id)) continue;
    const m = symbolMeta.get(id);
    if (!m) continue;
    const fnRec = files.get(m.file)?.functions.get(m.name) ?? null;
    nodesToAdd.set(id, {
      id, symbol: `${m.file}#${m.name}`, file: m.file, line: fnRec ? fnRec.line : null,
      lane: 'web', exported: fnRec ? (fnRec.exported ?? null) : null,
      ...(isComponentFile(m.file, files.get(m.file) ?? null) ? { component: true } : {}),
    });
  }
  for (const key of [...callCandidates.keys()].sort()) {
    const e = callCandidates.get(key);
    if (!reachingHttp.has(e.from) || !reachingHttp.has(e.to)) continue;
    stats.callsEdges[e.grade] += 1;
    const rule = e.evidence?.rule;
    if (typeof rule === 'string') stats.callsByRule[rule] = (stats.callsByRule[rule] ?? 0) + 1;
    edges.push({ from: e.from, to: e.to, type: 'CALLS', grade: e.grade, evidence: e.evidence });
  }
  stats.functions = {
    withHttp: httpFunctionIds.size,
    reachingHttp: reachingHttp.size - httpFunctionIds.size,
    created: reachingHttp.size,
  };
  return { symbolsByFile: symbolsPerFile(nodesToAdd) };
}
