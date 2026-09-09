// calls.mjs — which calls in a file SEND a request, and to what.
//
// WHAT THIS MODULE OWNS: the vocabulary of an HTTP call as this worker reads it
// in ONE file — which method names are verbs, how far a member chain is walked
// before the walk gives up, and (in the visitors the entry file hands it) which
// of the four kinds of client a callee reached.
//
// ONE FILE IS ALL IT SEES. Whether the name a call goes through really is a
// client, and which route the URL lands on, are questions only the bridge can
// answer, because both need the other files. What is recorded here is what the
// text says: this call, this callee, this URL argument, this method.
//
// WHAT IT MUST NEVER KNOW ABOUT: the graph, the routes a pack serves, the other
// files in the tree.

/** The HTTP verbs a call can name in its own callee, or a form can spell out. */
export const VERBS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);

/** How far a walk down a member/call spine goes before it gives up. */
export const HOP_GUARD = 64;

/** Whether a piece of text is written like a URL: a leading slash, or an address. */
export const looksLikeUrlText = (s) => typeof s === 'string' && (s.startsWith('/') || /^(https?:)?\/\//.test(s));

/** Whether an argument summary carries a URL anywhere in it. */
export function argCarriesUrl(summary) {
  if (!summary) return false;
  if (summary.kind === 'string') return looksLikeUrlText(summary.value);
  if (summary.kind === 'template') return looksLikeUrlText(summary.template);
  if (summary.kind === 'ternary') return summary.candidates.some(argCarriesUrl);
  if (summary.kind === 'object') return Object.prototype.hasOwnProperty.call(summary.keys, 'url');
  return false;
}

// A bare `'/'` is not evidence of anything: it is the separator, and
// `p.split('/')`, `p.lastIndexOf('/')` and `p.indexOf('/')` are how every
// frontend takes a path apart. A project that really does call the root path
// writes `{ url: '/' }`, and the object rule catches that untouched.
const evidenceOfAUrl = (text) => looksLikeUrlText(text) && text !== '/';

/**
 * WHICH POSITIONAL ARGUMENT IS THE URL, when no object argument spells `url:`.
 *
 * The loose answer, "the first string", is wrong on real code and wrong in a
 * way that quietly inflates every count downstream: a frontend is full of
 * `emit('close')`, `ref('')` and `useDesign('app-logo')`, and calling those
 * URLs would tell a reader this project makes ten times the HTTP calls it
 * makes. So an argument is the URL only when something SHOWS that it is:
 *
 *   - the call is HTTP-SHAPED (its callee is named after an HTTP verb), in
 *     which case the first non-config argument is the URL by every convention
 *     in the ecosystem, whatever it resolves to;
 *   - or the argument is text that reads like a path: a leading slash, a
 *     protocol-relative `//host/x`, or an absolute http/https address. Nothing
 *     but a URL is written that way;
 *   - or it is a name this file can follow to such text.
 *
 * A relative path with no leading slash (`get('user/list')`) is only caught by
 * the first rule. That is the known cost of not guessing.
 */
export function looksLikeUrlSummary(summary) {
  if (!summary) return false;
  if (summary.kind === 'string') return evidenceOfAUrl(summary.value);
  if (summary.kind === 'template') return evidenceOfAUrl(summary.template);
  if (summary.kind === 'ternary') return summary.candidates.some(looksLikeUrlSummary);
  return false;
}

/** Whether a name this file can follow leads to text written like a URL. */
function resolvesToUrl(ctx, summary, scope) {
  const r = resolveSummary(ctx, summary, scope, viaOf(ctx, summary), 1);
  return r !== null && r.length > 0 && r.every((x) => looksLikeUrlText(x.template));
}

// ---------------------------------------------------------------------------
// A function handed over as a VALUE
//
// A view that writes `usePagedList({ api: list, save })` never calls `list`,
// so a rule that follows CALLS sees nothing and the screen ends there. But
// the view did name the function, and whoever received it may call it: that
// is a real dependency and a sound candidate, and the bridge grades it as one.
//
// WHAT COUNTS AS A REFERENCE, and nothing else does:
//   - an identifier, in any argument position, or as the value of an
//     object-literal argument's property (one level deep, any key);
//   - a member of one (`api.list`, where `api` is a namespace import);
//   - and only when the file BINDS that identifier to an import or to a
//     function it declares itself. A parameter of the enclosing function is
//     not followable, and a global is not this project's.
//
// A string is a string, a call is already a call, and an inline arrow's own
// body is attributed to the enclosing named function, so none of the three is
// a reference here.
// ---------------------------------------------------------------------------

function refBindingOf(ctx, root, scope, classInfo) {
  const { top, bindingOf } = ctx;
  const b = bindingOf(root, scope, classInfo);
  if (!b) return null;
  if (b.kind === 'import') return { kind: 'import', source: b.source, imported: b.imported };
  if (b.kind === 'local' && top.functions.has(b.name)) return { kind: 'local', name: b.name };
  return null;
}

function refOf(ctx, node, env, via, key) {
  if (!node) return null;
  const keyPart = key === null ? {} : { key };
  if (node.type === 'Identifier') {
    const b = refBindingOf(ctx, node.name, env.scope, env.classInfo);
    return b ? { name: node.name, binding: b, via, ...keyPart } : null;
  }
  if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') {
    const c = ctx.calleeOf(node);
    if (!c || c.root === null || c.path.length === 0) return null;
    const b = refBindingOf(ctx, c.root, env.scope, env.classInfo);
    return b ? { name: c.root, path: c.path, binding: b, via, ...keyPart } : null;
  }
  return null;
}

/** Every function reference in one call's arguments, in source order, once each. */
function fnRefsOf(ctx, args, env) {
  const out = [];
  const seen = new Set();
  const add = (r) => {
    if (r === null) return;
    const k = JSON.stringify(r);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(r);
  };
  for (const a of args ?? []) {
    if (!a) continue;
    if (a.type === 'ObjectExpression') {
      for (const p of a.properties) {
        if (p.type !== 'ObjectProperty') continue;
        const key = ctx.keyName(p);
        if (key === null) continue;
        add(refOf(ctx, p.value, env, 'property', key));
      }
      continue;
    }
    add(refOf(ctx, a, env, 'argument', null));
  }
  return out;
}

/** The browser sink this call goes to, by contract: `fetch(url)`, `xhr.open(m, url)`. */
function platformSinkOf(ctx, { isNew, callee, binding }) {
  const { top } = ctx;
  let platformSink = null;
  if (!isNew && callee && callee.shape === 'ident' && callee.root === 'fetch' && binding && binding.kind === 'global') {
    platformSink = 'fetch';
  } else if (!isNew && callee && callee.name === 'open' && callee.path.length >= 1 && top.xhr.has(callee.root)) {
    platformSink = 'xhr';
  } else if (!isNew && callee && callee.name === 'open' && callee.root === 'XMLHttpRequest') {
    platformSink = 'xhr';
  }

  // A GLOBAL CLIENT THE PAGE LOADED. `$.ajax({url})`, `$.post(url)`: the root
  // is a name the pack lists, nothing in this file declares it, and the method
  // is one the pack names. `$('#x').val()` is not this — its callee sits on
  // the result of a call, which has no root name at all.
  return platformSink;
}

/**
 * A GLOBAL CLIENT THE PAGE LOADED. `$.ajax({url})`, `$.post(url)`: the root is
 * a name the pack lists, nothing in this file declares it, and the method is
 * one the pack names. `$('#x').val()` is not this — its callee sits on the
 * result of a call, which has no root name at all.
 */
function globalClientOf(ctx, { isNew, callee, binding }) {
  const { globalClients } = ctx;
  if (!(!isNew && callee !== null && callee.path.length === 1
    && binding !== null && binding.kind === 'global' && globalClients.has(callee.root))) return null;
  const client = globalClients.get(callee.root);
  const method = callee.path[0];
  const isConfig = (client.config?.methods ?? []).includes(method);
  const isVerb = Object.prototype.hasOwnProperty.call(client.verbs ?? {}, method);
  if (!isConfig && !isVerb) return null;
  return { client, method, isConfig };
}

/**
 * THE CLIENT THE FRAMEWORK HANDED IN. `$http` is a parameter, so nothing in
 * this file binds it and every rule above sees a call on an unknown name. What
 * makes it a client is the pack's own list plus where the function sits, and
 * both were settled before the walk. The verb has to be one the pack names, so
 * `$http.pending` is still nothing.
 */
function injectedClientOf({ isNew, callee, env }) {
  let injected = null;
  if (!isNew && callee !== null && env.injected) {
    const client = env.injected.get(callee.root);
    if (client) {
      const verb = callee.path.length === 0 ? '(call)' : callee.path[callee.path.length - 1];
      const known = callee.path.length === 0
        ? (client.generic ?? []).includes('(call)')
        : Object.prototype.hasOwnProperty.call(client.verbs ?? {}, verb) || (client.generic ?? []).includes(verb);
      if (known) injected = { client: client.name, framework: client.framework ?? null };
    }
  }

  return injected;
}

/** Which argument holds the URL, once it is known what kind of call this is. */
function urlArgumentOf(ctx, { callee, summaries, routeArg, platformSink, globalClient, env }) {
  let urlSummary = null;
  if (globalClient !== null) {
    // `$.ajax({url: …})` and `$.ajax(url, settings)` are the same call
    // written two ways; a verb call (`$.post(url, data)`) puts it first.
    const at = summaries[globalClient.client.config?.urlArg ?? globalClient.client.urlArg ?? 0] ?? null;
    if (!globalClient.isConfig) urlSummary = at;
    else if (at && at.kind === 'object') {
      urlSummary = Object.prototype.hasOwnProperty.call(at.keys, globalClient.client.config.urlKey)
        ? at.keys[globalClient.client.config.urlKey] : null;
    } else urlSummary = at;
  } else if (platformSink === 'xhr') {
    urlSummary = summaries[1] ?? null;
  } else if (platformSink === 'fetch') {
    urlSummary = summaries[0] ?? null;
  } else {
    for (let i = 0; i < summaries.length; i += 1) {
      const s = summaries[i];
      if (routeArg[i]) continue;
      if (s.kind === 'object' && Object.prototype.hasOwnProperty.call(s.keys, 'url')) {
        urlSummary = s.keys.url;
        break;
      }
    }
    if (urlSummary === null) {
      const httpShaped = typeof callee.name === 'string' && VERBS.has(callee.name.toUpperCase());
      for (let i = 0; i < summaries.length; i += 1) {
        const s = summaries[i];
        if (routeArg[i]) continue;
        if (s.kind === 'object' || s.kind === 'other') continue;
        if (httpShaped) { urlSummary = s; break; }
        if (looksLikeUrlSummary(s)) { urlSummary = s; break; }
        if ((s.kind === 'member' || s.kind === 'ident') && resolvesToUrl(ctx, s, env.scope)) {
          urlSummary = s; break;
        }
      }
    }
  }
  return urlSummary;
}

/** The HTTP method this call sends, and what said so. */
function methodOf(callee, summaries, platformSink, globalClient = null) {
  const fromObject = (keys = ['method', 'type']) => {
    for (const s of summaries) {
      if (s.kind !== 'object') continue;
      for (const key of keys) {
        const v = s.keys[key];
        if (v && v.kind === 'string' && VERBS.has(v.value.toUpperCase())) {
          return v.value.toUpperCase();
        }
      }
    }
    return null;
  };
  if (globalClient !== null) {
    // The pack's own verb table first: `getJSON` is a GET and is spelled like
    // nothing. Then the config keys, for the one method that takes a config.
    const verbs = globalClient.client.verbs ?? {};
    if (Object.prototype.hasOwnProperty.call(verbs, globalClient.method)) {
      return { value: verbs[globalClient.method], from: 'callee-name' };
    }
    const v = fromObject(globalClient.client.config?.methodKeys ?? []);
    return v ? { value: v, from: 'config' } : null;
  }
  if (platformSink === 'xhr') {
    const first = summaries[0];
    if (first && first.kind === 'string' && VERBS.has(first.value.toUpperCase())) {
      return { value: first.value.toUpperCase(), from: 'positional' };
    }
    return null;
  }
  if (platformSink === 'fetch') {
    const v = fromObject();
    return v ? { value: v, from: 'positional' } : null;
  }
  if (callee && typeof callee.name === 'string' && VERBS.has(callee.name.toUpperCase())) {
    return { value: callee.name.toUpperCase(), from: 'callee-name' };
  }
  const v = fromObject();
  return v ? { value: v, from: 'config' } : null;
}

/** One call, read for what it sends and for what it hands over. */
export function visitCall(ctx, node, env) {
  const {
    lineOf, relFile, emit, packs, top, declarationCalls, calleeOf, bindingOf, isRequireCall,
    summarizeArg, moduleEnclosing, anyPackSeesARoute, eachChild,
  } = ctx;
  const visit = (n, e) => ctx.visit(n, e);
  const isNew = node.type === 'NewExpression';
  const calleeNode = node.callee;
  // `import('x')` is not a call to anything this file declares: it is the
  // route-component form, and it is recorded as a dynamic import.
  if (!isNew && calleeNode && calleeNode.type === 'Import') {
    const arg = node.arguments[0];
    const line = lineOf(node);
    if (arg && arg.type === 'StringLiteral') {
      emit({ kind: 'import', file: relFile, line, source: arg.value, specifiers: [], dynamic: true }, line);
    }
    for (const a of node.arguments) visit(a, env);
    return;
  }
  const callee = calleeNode ? calleeOf(calleeNode) : null;
  const line = lineOf(node);

  // `require('x')` is the CommonJS spelling of an import.
  if (isRequireCall(node, env)) {
    emit({
      kind: 'import', file: relFile, line, source: node.arguments[0].value,
      specifiers: env.requireLocal ? [{ imported: 'default', local: env.requireLocal }] : [],
      dynamic: false,
    }, line);
    return;
  }

  // A CALL A PACK LISTS AS A DECLARATION SENDS NOTHING.
  // `$urlRouterProvider.otherwise('/welcome')` names the route to fall back
  // to; reading it as a request put `ANY /welcome` in the pack and let a
  // frontend "call" a table it never touches. The arguments are still walked,
  // because a real call can sit inside one.
  if (!isNew && callee !== null) {
    const declared = packs.some((p) => (p.declarationCalls ?? []).some(
      (d) => (d.receivers ?? []).includes(callee.root)
        && (d.methods ?? []).includes(callee.path.length > 0 ? callee.path[callee.path.length - 1] : callee.root),
    ));
    if (declared || declarationCalls.has(node)) {
      for (const a of node.arguments) visit(a, env);
      return;
    }
  }

  const argNodes = node.arguments.slice(0, 3);
  // AN OBJECT A ROUTER PACK READS AS A ROUTE IS NOT A REQUEST. Its `path` or
  // `url` is where the browser goes, not where a request is sent, and the
  // route reader has already recorded it as one.
  const routeArg = argNodes.map((a) => anyPackSeesARoute(packs, a));
  const summaries = argNodes.map((a) => summarizeArg(a));
  const binding = callee ? bindingOf(callee.root, env.scope, env.classInfo) : null;
  let platformSink = platformSinkOf(ctx, { isNew, callee, binding });
  const globalClient = globalClientOf(ctx, { isNew, callee, binding });
  if (globalClient !== null) platformSink = globalClient.client.name;
  // `this.something(…)` inside a class, where `something` is a member THIS
  // class declares or assigns. That restriction is what keeps the stream from
  // filling up with every `this.$emit`, `this.setState` and `this.$refs.x`
  // call a component makes: only a member of this class can be the client it
  // sends through, and only a member of this class is a call the bridge can
  // follow within the file.
  const throughThis = binding !== null && binding.kind === 'this'
    && callee.path.length >= 1 && env.classInfo.members.has(callee.path[0]);
  const goesThroughABinding = binding !== null
    && (binding.kind === 'import' || (binding.kind === 'local' && top.bindings.has(binding.name)) || throughThis);
  const carriesUrl = summaries.some((s, i) => !routeArg[i] && argCarriesUrl(s));

  // THE CLIENT THE FRAMEWORK HANDED IN. `$http` is a parameter, so nothing in
  // this file binds it and every rule above sees a call on an unknown name.
  // What makes it a client is the pack's own list plus where the function
  // sits, and both were settled before the walk. The verb has to be one the
  // pack names, so `$http.pending` is still nothing.
  const injected = injectedClientOf({ isNew, callee, env });
  if (callee !== null && (goesThroughABinding || carriesUrl || platformSink !== null || injected !== null)) {
    const rec = {
      kind: 'call', file: relFile, line,
      enclosing: env.func ? (env.func.finalName ?? env.func.baseName) : moduleEnclosing,
      callee: isNew ? { ...callee, shape: 'new' } : callee,
      binding,
      args: summaries,
      url: null,
      method: null,
      platformSink,
      ...(injected !== null ? { injected } : {}),
    };
    if (env.func) rec.__enclosingEntry = env.func;

    const urlSummary = urlArgumentOf(ctx, {
      callee, summaries, routeArg, platformSink, globalClient, env,
    });
    if (urlSummary !== null) rec.url = buildUrl(ctx, urlSummary, env.scope);

    // ---- the method -------------------------------------------------
    rec.method = methodOf(callee, summaries, platformSink, globalClient);

    // ---- the functions this call HANDS OVER --------------------------
    // Left off when there are none, so a frontend's tens of thousands of
    // ordinary call records do not each grow an empty list.
    const refs = fnRefsOf(ctx, node.arguments, env);
    if (refs.length > 0) rec.fnRefs = refs;

    emit(rec, line);
  }

  for (const a of node.arguments) visit(a, env);
  if (calleeNode && calleeNode.type !== 'Identifier') {
    // A call on the result of another call (`create().get(…)`) still has to
    // be walked, or the inner call disappears.
    eachChild(calleeNode, (child) => visit(child, env));
  }
}

// ---------------------------------------------------------------------------
// URL resolution, FILE-LOCALLY
//
// `via` names the OUTERMOST form the URL argument was written in, so every
// candidate of one argument carries the same one and a reader can tell a
// literal from a name that had to be followed:
//   literal        '/things/list' written where it is used
//   template       a template literal or a `+` concatenation
//   local-constant an enum/object member or a top-level constant of this file
//   local-variable a `const` of the enclosing function, followed once
//   ternary        a conditional written in the argument itself
// ---------------------------------------------------------------------------

/** Every URL one argument can be, or null when this file cannot say. */
export function resolveSummary(ctx, summary, scope, via, depth) {
  const { top, summarizeArg } = ctx;
  if (!summary) return null;
  if (summary.kind === 'string') return [{ template: summary.value, dynamicParts: 0, via }];
  if (summary.kind === 'template') return [{ template: summary.template, dynamicParts: summary.dynamicParts, via }];
  if (summary.kind === 'ternary') {
    const out = [];
    for (const c of summary.candidates) {
      const r = resolveSummary(ctx, c, scope, via, depth);
      if (r === null) return null;
      out.push(...r);
    }
    return out.length > 0 ? out : null;
  }
  if (summary.kind === 'member') {
    const c = top.constants.get(summary.root);
    if (c && c.members && summary.path.length >= 1 && c.members.has(summary.path[0])) {
      return [{ template: c.members.get(summary.path[0]), dynamicParts: 0, via }];
    }
    return null;
  }
  if (summary.kind === 'ident') {
    const c = top.constants.get(summary.name);
    if (c && c.value !== null && c.value !== undefined) {
      return [{ template: c.value, dynamicParts: 0, via }];
    }
    if (depth <= 0) return null;
    const found = scope.find(summary.name);
    if (found && !found.isModule && found.names.get(summary.name)) {
      // A local `const` is followed ONCE. Twice would be a data-flow
      // analysis, and this worker is deliberately not one.
      return resolveSummary(ctx, summarizeArg(found.names.get(summary.name)), scope, via, depth - 1);
    }
    return null;
  }
  return null;
}

/** WHY a URL did not resolve, in the one word the bridge counts it under. */
export function whyUnresolved(ctx, summary, scope) {
  const { top } = ctx;
  if (!summary) return 'expression';
  if (summary.kind === 'ident') {
    const found = scope.find(summary.name);
    if (found && !found.isModule) return 'parameter';
    if (top.imports.has(summary.name)) return 'imported-constant';
    return 'expression';
  }
  if (summary.kind === 'member') {
    if (top.imports.has(summary.root)) return 'imported-constant';
    const found = scope.find(summary.root);
    if (found && !found.isModule) return 'parameter';
    return 'expression';
  }
  if (summary.kind === 'ternary') {
    for (const c of summary.candidates) {
      const why = whyUnresolved(ctx, c, scope);
      if (why !== 'expression') return why;
    }
    return 'expression';
  }
  return 'expression';
}

/** The outermost form the argument was written in. */
export function viaOf(ctx, summary) {
  const { top } = ctx;
  if (!summary) return 'literal';
  if (summary.kind === 'string') return 'literal';
  if (summary.kind === 'template') return 'template';
  if (summary.kind === 'ternary') return 'ternary';
  if (summary.kind === 'member') return 'local-constant';
  if (summary.kind === 'ident') return top.constants.has(summary.name) ? 'local-constant' : 'local-variable';
  return 'literal';
}

/** One call's URL: what it resolved to, or why it did not. */
export function buildUrl(ctx, summary, scope) {
  const { top } = ctx;
  if (!summary) return null;
  const url = { arg: summary };
  // The name the URL is built ON TOP OF, when the text starts with one. Only
  // the bridge can say what that name holds, because the file that assigns it
  // is as often another file (RM48).
  if (summary.kind === 'template' && typeof summary.base === 'string') url.base = summary.base;
  let resolved = resolveSummary(ctx, summary, scope, viaOf(ctx, summary), 1);
  if (resolved === null) {
    url.resolved = null;
    url.unresolved = whyUnresolved(ctx, summary, scope);
    if (summary.kind === 'member' && top.imports.has(summary.root)) {
      const imp = top.imports.get(summary.root);
      url.binding = { kind: 'import', source: imp.source, imported: imp.imported };
    } else if (summary.kind === 'ident' && top.imports.has(summary.name)) {
      const imp = top.imports.get(summary.name);
      url.binding = { kind: 'import', source: imp.source, imported: imp.imported };
    }
    return url;
  }
  let query = null;
  let absolute = null;
  resolved = resolved.map((r) => {
    let t = r.template;
    const abs = /^(https?:)?\/\/([^/]+)(\/.*)?$/.exec(t);
    if (abs) {
      absolute = { host: abs[2], path: abs[3] ?? '/' };
      t = abs[3] ?? '/';
    }
    const q = t.indexOf('?');
    if (q >= 0) { if (query === null) query = t.slice(q + 1); t = t.slice(0, q); }
    return { ...r, template: t };
  });
  url.resolved = resolved;
  if (query !== null) url.query = query;
  if (absolute !== null) url.absolute = absolute;
  return url;
}
