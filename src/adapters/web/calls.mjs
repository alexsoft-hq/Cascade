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
import { isComponentFile, webEndpointId, webSymbolId } from './symbols.mjs';
import { TEMPLATE_PREFIX } from './prefix.mjs';
import { gatewayRouteOf } from '../../core/profile.mjs';

/** Hosts that mean "this machine", so an absolute URL to one is not another deployable. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]']);

/** What each evidence layer actually did, in one sentence, for `evidence.basis`. */
export const WEB_CALL_BASIS = Object.freeze({
  platform: 'the call goes to a browser sink (fetch / XMLHttpRequest), which sends the request itself: the URL argument is the URL by contract, and no rule had to decide that this call is an HTTP call',
  library: 'the callee is an instance of an HTTP client library a declaration pack names (adapters/web/packs/http-clients.json), and the method called is one of that library\'s verbs, so the call sends a request and the URL it sends to is the argument the library reads',
  injected: 'the callee is a client the FRAMEWORK hands the function, named in a declaration pack (adapters/web/packs/http-clients.json) and found by parameter name inside a function the framework fills in. Nothing in the file binds it, so there was nothing to trace: the pack says that parameter is a client and the method called is one of its verbs',
  wrapper: 'the callee was traced through the project\'s own wrapper(s) to a client library instance, by following what each name is BOUND to in its file and what each wrapper forwards. The chain is on the edge; every hop is a binding this lane read, not a name it recognized',
  untraced: 'the argument is URL-shaped but the callee could not be traced to any sink: the call may send this URL or may only build it, so the edge says a rule guessed and the grade is HEURISTIC',
  template: 'the page itself makes this request: a `<form action=…>` posts to it, or a link opens it. The markup names the path and the attribute names the method, so nothing had to be traced and nothing was assumed',
  // RM56. A Nexacro client sends every request through one framework call, so
  // there is no client library to trace and no wrapper chain to follow.
  nexacro: 'the screen calls `transaction(…)`, which is the ONE way a Nexacro client sends a request: the framework opens the connection and the url is the argument, or the property of the options object, that it reads. The service prefix on the front of it (`svcurl::`) is resolved through the application typedef\'s own `<Service prefixid url>` list, so nothing here was matched by name',
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
 * B6: the routes this pack SERVES, indexed the two ways a call is matched
 * against them — exactly, and by template.
 *
 * @param {import('../../core/graph.mjs').Graph} g
 * @returns {{exactPaths:Set<string>, templatePaths:string[], matchUrl:Function}}
 */
export function buildRouteIndex(g) {
  const exactPaths = new Set();
  const templatePaths = [];
  const routesByPath = new Map(); // normalized path -> [{id, httpMethod, path}]
  for (const n of g.nodes.values()) {
    if (n.kind !== 'endpoint' || n.outbound === true || typeof n.path !== 'string') continue;
    const p = normalizeUrl(n.path);
    if (!routesByPath.has(p)) routesByPath.set(p, []);
    routesByPath.get(p).push({ id: n.id, httpMethod: n.httpMethod ?? 'ANY', path: p });
    exactPaths.add(p);
    templatePaths.push(p);
  }
  templatePaths.sort();
  const allRoutes = [...routesByPath.keys()].sort();

  const methodOk = (route, method) => method === null || route.httpMethod === 'ANY' || route.httpMethod === method;
  const matchUrl = (full, method) => {
    const p = normalizeUrl(full);
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
  return { exactPaths, templatePaths, matchUrl };
}

/**
 * What a CALL's callee resolves to. Four answers, and the grade of the edge
 * follows from which one it is:
 *   sink      the callee IS a client instance or a platform sink
 *   member    the callee is a function/method of this project (maybe a wrapper)
 *   external  the callee comes from a package this analysis never read
 *   null      nothing here explains it
 */
function makeCalleeTarget({ libraries, packageOf, resolver }) {
  const { rootValue, fieldValue } = resolver;
  return (file, call) => {
    const callee = call.callee ?? null;
    if (!callee) return null;
    const pathParts = callee.path ?? [];
    const binding = call.binding ?? null;
    if (binding && binding.kind === 'this') {
      const className = binding.class ?? null;
      if (!className) return null;
      if (pathParts.length === 1) {
        return { kind: 'member', key: `${file}#${className}.${pathParts[0]}`, assumed: false, viaStar: false };
      }
      if (pathParts.length >= 2) {
        const v = fieldValue(file, className, pathParts[0], 0);
        if (v && v.kind === 'sink-instance') {
          return { kind: 'sink', instance: v, method: pathParts[1], assumed: v.assumed === true, viaStar: v.viaStar === true };
        }
        if (v && v.kind === 'class-instance') {
          const at = v.key.lastIndexOf('#');
          return {
            kind: 'member', key: `${v.key.slice(0, at)}#${v.key.slice(at + 1)}.${pathParts[1]}`,
            assumed: v.assumed === true, viaStar: v.viaStar === true,
          };
        }
      }
      return null;
    }
    const root = rootValue(file, callee, binding, 0);
    if (root === null) return null;
    const flags = { assumed: root.assumed === true, viaStar: root.viaStar === true };
    if (root.kind === 'external' || root.kind === 'namespace') {
      const module = root.kind === 'external' ? root.module : null;
      const lib = module ? libraries.get(module) : null;
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
  let best = null;
  const consider = (cand) => {
    if (!cand) return;
    if (best === null || cand.depth < best.depth || (cand.depth === best.depth && cmp(cand.next ?? '', best.next ?? '') < 0)) best = cand;
  };
  for (const c of callsIn.get(key) ?? []) {
    if (hasOwnUrl(c)) continue;
    const t = calleeTarget(m.file, c);
    if (!t) continue;
    if (t.kind === 'sink') {
      const v = sinkVerb(t);
      if (!v) continue;
      consider({ depth: 1, next: null, sink: { module: t.instance.module, instance: t.instance.id ?? null, kind: 'library' }, call: c });
    } else if (t.kind === 'member' && t.key !== key) {
      const w = wrappers.get(t.key);
      if (!w) continue;
      consider({ depth: 1 + w.depth, next: t.key, sink: w.sink, call: c });
    }
    if (c.platformSink) {
      consider({ depth: 1, next: null, sink: { module: c.platformSink, instance: null, kind: 'platform' }, call: c });
    }
  }
  // `get(config) { return this.request({ …config, method: 'GET' }) }` is the
  // same hop written as a return, and a body with no call record left (an
  // arrow that IS the call) is only visible this way.
  const ret = m.rec.returns ?? null;
  if (ret && ret.callee) {
    const t = calleeTarget(m.file, { callee: ret.callee, binding: ret.binding ?? null });
    if (t && t.kind === 'member' && t.key !== key) {
      const w = wrappers.get(t.key);
      if (w) consider({ depth: 1 + w.depth, next: t.key, sink: w.sink, call: null });
    }
  }
  return best;
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
  fileNames, files, libraries, pack, packageOf, resolver, stats,
}) {
  const calleeTarget = makeCalleeTarget({ libraries, packageOf, resolver });
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
  stats.wrappers.count = wrappers.size;
  for (const [key, w] of wrappers) {
    stats.wrappers.maxDepth = Math.max(stats.wrappers.maxDepth, w.depth);
    const name = key.slice(key.lastIndexOf('#') + 1);
    if (name.includes('.')) stats.wrappers.byKind.classMethod += 1; else stats.wrappers.byKind.function += 1;
  }
  return { wrappers, calleeTarget, sinkVerb, platformOf };
}

/**
 * Whether a resolved URL is WRITTEN like one: a leading slash, or an absolute
 * address. A URL that never resolved is kept (its shape is unknown, and it is
 * counted by reason further down); one that resolved to a bare word is not.
 */
function urlShaped(c, resolved) {
  if (c.url.absolute) return true;
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
function withContextPath(call, contextVars) {
  const resolved = Array.isArray(call.url.resolved) ? call.url.resolved : null;
  if (resolved === null || contextVars === null) return resolved;
  if (typeof call.url.base !== 'string' || !contextVars.has(call.url.base)) return resolved;
  return resolved.map((r) => (typeof r.template === 'string' && r.template.startsWith('{*}')
    ? { ...r, template: r.template.slice(3), dynamicParts: Math.max(0, (r.dynamicParts ?? 1) - 1) }
    : r));
}

/** The HTTP method this call sends, and what said so. */
function makeMethodFor({ wrappers, libraries, pack, injectedClients }) {
  return (c, sink, target) => {
    if (sink.kind === 'wrapper' && target && target.kind === 'member') {
      const w = wrappers.get(target.key);
      const verbCall = w && w.call ? w.call : null;
      if (verbCall && verbCall.method && verbCall.method.value) {
        return { value: verbCall.method.value, from: 'wrapper-verb' };
      }
    }
    if (c.method && c.method.value) return { value: c.method.value, from: c.method.from ?? 'config' };
    if (sink.kind === 'library' || sink.kind === 'wrapper') {
      const lib = libraries.get(sink.module);
      if (lib && lib.defaultMethod) return { value: lib.defaultMethod, from: 'library-default' };
    }
    if (sink.kind === 'platform') {
      const p = (pack.platform ?? []).find((x) => x.name === sink.module);
      if (p && p.defaultMethod) return { value: p.defaultMethod, from: 'library-default' };
    }
    if (sink.kind === 'injected') {
      const cl = injectedClients.get(sink.module);
      if (cl && cl.defaultMethod) return { value: cl.defaultMethod, from: 'library-default' };
    }
    return { value: null, from: 'absent' };
  };
}

/** Which of the six kinds of sink ONE call reached, or null when it is not a call at all. */
function sinkOf(file, c, { resolved, isTemplate, pkg, deps }) {
  const {
    platformOf, injectedClients, calleeTarget, sinkVerb, wrappers, noteInstance, stats,
  } = deps;
  const platform = platformOf(c);
  // A NEXACRO TRANSACTION IS A REQUEST BY CONTRACT (RM56): one call, one url,
  // nothing to trace. First, because that file is also a template.
  if (c.nexacro) {
    stats.calls.nexacro += 1;
    return { sink: { kind: 'nexacro', module: 'transaction', instance: null, chain: [], depth: 0 }, target: null };
  }
  if (isTemplate && c.template && typeof c.template.rule === 'string') {
    // A FORM AND A LINK ARE THE PAGE'S OWN CALLS. Nothing had to be traced:
    // the markup names the path and the attribute names the method.
    stats.calls.template += 1;
    return { sink: { kind: 'template', module: c.template.rule, instance: null, chain: [], depth: 0 }, target: null };
  }
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
        chain: [], depth: 0,
      },
      target,
    };
  }
  if (target && target.kind === 'member' && wrappers.has(target.key)) {
    const chain = [];
    let cur = target.key;
    for (let i = 0; i < FIXPOINT_LIMIT && cur; i += 1) {
      chain.push(cur);
      cur = wrappers.get(cur)?.next ?? null;
    }
    const w = wrappers.get(target.key);
    stats.calls.traced += 1;
    return {
      sink: {
        kind: 'wrapper', module: w.sink.module, instance: w.sink.instance,
        chain: chain.reverse(), depth: w.depth,
      },
      target,
    };
  }
  // AN UNTRACED CALL IS ONLY A CALL WHEN ITS ARGUMENT LOOKS LIKE A URL.
  //
  // The worker records the first argument of any verb-named call as the
  // URL, by the ecosystem's own convention, and that convention is right
  // for `thing.get('/x')` and wrong for `Cookies.get('size')`. Nothing in
  // ONE FILE can tell those apart; the bridge can, because it knows
  // whether the callee reached a client library at all. So a call that
  // reached none AND whose argument is not written like a path is not an
  // HTTP call here: it is counted (`notUrlShaped`) and left alone, rather
  // than becoming a route named `/size` that nothing serves.
  if (!urlShaped(c, resolved)) { stats.calls.notUrlShaped += 1; return null; }
  stats.calls.untraced += 1;
  return {
    sink: { kind: 'untraced', module: target && target.kind === 'external' ? target.module : null, instance: null, chain: [], depth: 0 },
    target,
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
  const methodFor = makeMethodFor(deps);
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
      // A TRANSACTION WITH NO URL (RM56) is a request this lane knows happens
      // and cannot follow, which is not the same finding as no request.
      if (c.nexacro && !c.url) { stats.calls.nexacroUnreadable += 1; continue; }
      if (!c.url) continue;
      const resolved = withContextPath(c, ctxVars);
      const found = sinkOf(file, c, { resolved, isTemplate, pkg, deps });
      if (found === null) continue;
      const { sink, target } = found;
      stats.calls.withUrl += 1;
      const instanceId = sink.instance ?? `${pkg}#(package)`;
      if (!instanceOf.has(instanceId)) {
        instanceOf.set(instanceId, { id: instanceId, module: sink.module, baseURL: null, package: pkg });
      }
      const method = methodFor(c, sink, target);
      sites.push({
        file, pkg, call: c, sink, target, instanceId, method,
        assumed: (target && target.assumed === true) || false,
        template: isTemplate, resolved,
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
  let prefixEvidence = { value: prefix.value, from: prefix.from };
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
    ...(isComponentFile(file) ? { component: true } : {}),
  });
  return fromId;
}

/** Everything an edge from this call site says about itself. */
function callEvidence(site, { written, full, via, absolute, prefixEvidence, declaredService, found }) {
  const { call, sink } = site;
  const evidence = {
    rule: call.nexacro ? 'nexacro-transaction'
      : site.template && call.template ? call.template.rule : 'web-http-call',
    ...(call.nexacro ? { nexacro: call.nexacro } : {}),
    basis: WEB_CALL_BASIS[sink.kind],
    ...(site.template && call.template ? { attribute: call.template.attr, wrote: call.template.written } : {}),
    sink: { kind: sink.kind, module: sink.module, instance: sink.instance, chain: sink.chain, depth: sink.depth },
    // `written` is the path as the code spells it, `template` the path this
    // pack was searched for. An absolute URL keeps its HOST here, because
    // the node id is a path and two hosts would otherwise be one node.
    url: {
      written, template: full, via,
      ...(absolute ? { host: absolute.host } : {}),
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
  };
  if (site.assumed) evidence.alias = 'assumed';
  return evidence;
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

  const fromId = noteCaller(site, nodesToAdd, files);
  httpFunctionIds.add(fromId);
  const evidence = callEvidence(site, {
    written, full, via: cand.via ?? null, absolute, prefixEvidence, declaredService, found,
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
  const many = found.routes.length > 1;
  for (const r of found.routes.slice().sort((a, b) => cmp(a.id, b.id))) {
    matchedRoutePaths.add(r.path);
    edges.push({
      from: fromId,
      to: r.id,
      type: 'CALLS_HTTP',
      grade,
      evidence: many ? { ...evidence, candidates: found.routes.length } : evidence,
    });
  }
  return { how: found.how, routes: found.routes.length, grade };
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
 * The SECOND pass: one CALLS_HTTP edge per (call candidate, route it matched),
 * and an outbound endpoint node for a URL nothing here answers.
 *
 * @returns {{httpFunctionIds:Set<string>, matchedRoutePaths:Set<string>, unmatched:Map}}
 */
export function placeHttpEdges({
  sites, g, files, nodesToAdd, edges, stats, prefixOf, matchUrl, configFor,
  gatewayRoutes, gatewayKeys,
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
    const prefix = site.template ? TEMPLATE_PREFIX : prefixOf(site.instanceId);
    const absolute = call.url.absolute ?? null;
    const outsidePack = absolute !== null && !LOCAL_HOSTS.has(absolute.host)
      && !configFor(site.pkg).proxies.some((p) => typeof p.target === 'string' && p.target.includes(absolute.host));
    const ctx = {
      g, files, nodesToAdd, edges, stats, matchUrl, gatewayRoutes, gatewayKeys,
      prefix, absolute, outsidePack, unmatched, httpFunctionIds, matchedRoutePaths,
    };
    const seen = { grade: null, match: null, multi: false, missed: false, allHoles: false };
    for (const cand of site.resolved) {
      const got = placeCandidate(cand, site, ctx);
      if (got.allHoles) { seen.allHoles = true; continue; }
      if (got.missed) { seen.missed = true; continue; }
      if (got.routes > 1) seen.multi = true;
      if (seen.match === null || (seen.match === 'template' && got.how === 'exact')) seen.match = got.how;
      if (seen.grade === null || GRADE_RANK[got.grade] < GRADE_RANK[seen.grade]) seen.grade = got.grade;
    }
    countSite(site, seen, { stats, unmatched, prefix, outsidePack });
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
// A member call on an imported OBJECT (`client.get(...)`, where `client` is a
// client instance) is not a call to a function this lane read, and it is not
// counted as a miss either: the HTTP pass above already explained it.
// ---------------------------------------------------------------------------

/** What one call NAMES, when it names a function this lane read. */
function makeCallTargetOf({ files, resolver, httpSiteCalls, stats }) {
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
      if (parts.length !== 1 || typeof binding.class !== 'string') return null;
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
    const namespace = imp.imported === '*';
    if (namespace ? parts.length !== 1 : parts.length !== 0) return null;
    const r = resolveSpecifier(file, imp.source);
    if (!r.file) return null; // a package this analysis never read
    const wanted = namespace ? parts[0] : imp.imported;
    const hit = resolveExport(r.file, wanted, 0);
    if (!hit || hit.external || !hit.file) return null;
    if (!files.get(hit.file)?.functions.has(hit.name)) {
      // It resolved, and what it landed on is not a function: a constant, a
      // component, a client. No edge, and a number rather than a silence —
      // except where the HTTP pass above already explained this call, because a
      // call onto a client instance is not a missing hop, it is the sink.
      if (!httpSiteCalls.has(c)) stats.calls.notAFunction += 1;
      return null;
    }
    const assumed = hit.assumed === true || r.assumed === true;
    const viaStar = hit.viaStar === true;
    const grade = assumed ? 'HEURISTIC' : viaStar ? 'SOUND_SET' : 'EXACT';
    const evidence = { rule: 'esm-import', specifier: imp.source, origin: `${hit.file}#${hit.name}` };
    if (viaStar) evidence.viaStar = true;
    if (assumed) evidence.assumedAlias = true;
    return { file: hit.file, name: hit.name, grade, evidence };
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
function makeFnRefTargetOf({ files, resolver }) {
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
    const namespace = imp.imported === '*';
    if (namespace ? parts.length !== 1 : parts.length !== 0) return null;
    const r = resolveSpecifier(file, imp.source);
    if (!r.file) return null; // a package this analysis never read
    const wanted = namespace ? parts[0] : imp.imported;
    const hit = resolveExport(r.file, wanted, 0);
    if (!hit || hit.external || !hit.file) return null;
    // What was passed is not a function this lane read: a constant, a component,
    // a client instance. Handing one of those over is ordinary, and it is not a
    // missing hop, so it is not counted as one either.
    if (!files.get(hit.file)?.functions.has(hit.name)) return null;
    const assumed = hit.assumed === true || r.assumed === true;
    const evidence = {
      rule: 'passed-as-value', via, ...keyPart, specifier: imp.source, origin: `${hit.file}#${hit.name}`,
    };
    if (hit.viaStar === true) evidence.viaStar = true;
    if (assumed) evidence.assumedAlias = true;
    return { file: hit.file, name: hit.name, grade: assumed ? 'HEURISTIC' : 'SOUND_SET', evidence };
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
      if (t) remember(file, c.enclosing ?? '(module)', t);
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
  const callTargetOf = makeCallTargetOf({ files, resolver, httpSiteCalls, stats });
  const fnRefTargetOf = makeFnRefTargetOf({ files, resolver });

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
      ...(isComponentFile(m.file) ? { component: true } : {}),
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
