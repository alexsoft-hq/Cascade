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

import { navigationOf } from './navigation.mjs';
import { resolveTransactionUrl, TRANSACTION_METHOD, TRANSACTION_URL_KEYS } from './nexacro.mjs';

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

/**
 * Whether a name this file can follow leads to text written like a URL.
 *
 * Read WITHOUT substituting constants, on purpose (RM58). This question decides
 * whether an argument IS the URL, and answering it on text a constant was put
 * into would make this lane count calls it never counted before: `f(`${BASE}/x`)`
 * would become a request the moment `BASE` is a path. Which calls a frontend
 * makes is not what a substitution rule is allowed to change, so the decision is
 * made on the text as written and the substitution only improves the answer for
 * a call already recognised.
 */
function resolvesToUrl(ctx, summary, scope) {
  const r = resolveSummary(ctx, summary, scope, viaOf(ctx, summary), 1, false);
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

/**
 * THE FOUR THINGS A CALL CAN BE BEFORE IT CAN BE A REQUEST.
 *
 * Each of them ends the walk of this node, and each is a different reason:
 *   a dynamic import  `import('x')` is the route-component form, not a call to
 *                     anything this file declares
 *   a transaction     the ONE way a Nexacro client sends a request (RM56), read
 *                     first because every rule below would fail to see it
 *   `require('x')`    the CommonJS spelling of an import
 *   a declaration     a call a pack lists as DECLARING rather than sending.
 *                     `$urlRouterProvider.otherwise('/welcome')` names the route
 *                     to fall back to; reading it as a request put `ANY /welcome`
 *                     in the pack and let a frontend "call" a table it never
 *                     touches. Its arguments are still walked, because a real
 *                     call can sit inside one
 *
 * @returns {{record:(object|null), walkArgs:boolean}|null} null when this call
 *          is none of them and the request rules should read it
 */
function beforeARequest(ctx, node, env, { isNew, calleeNode, callee, line }) {
  const { relFile, packs, declarationCalls, isRequireCall } = ctx;
  if (!isNew && calleeNode && calleeNode.type === 'Import') {
    const arg = node.arguments[0];
    const record = arg && arg.type === 'StringLiteral'
      ? { kind: 'import', file: relFile, line, source: arg.value, specifiers: [], dynamic: true } : null;
    return { record, walkArgs: true };
  }
  const transaction = isNew ? null : nexacroTransactionOf(ctx, node, env, callee, line);
  if (transaction !== null) return { record: transaction, walkArgs: true };
  if (isRequireCall(node, env)) {
    return {
      record: {
        kind: 'import', file: relFile, line, source: node.arguments[0].value,
        specifiers: env.requireLocal ? [{ imported: 'default', local: env.requireLocal }] : [],
        dynamic: false,
      },
      walkArgs: false,
    };
  }
  if (!isNew && callee !== null) {
    const declared = packs.some((p) => (p.declarationCalls ?? []).some(
      (d) => (d.receivers ?? []).includes(callee.root)
        && (d.methods ?? []).includes(callee.path.length > 0 ? callee.path[callee.path.length - 1] : callee.root),
    ));
    if (declared || declarationCalls.has(node)) return { record: null, walkArgs: true };
  }
  return null;
}

/**
 * THE CALL RECORD, when this call is one this lane records at all.
 *
 * It is recorded when the callee goes through a name this file BINDS, or when
 * an argument carries a URL, or when it reached a browser sink or a client the
 * framework injected. Anything else is one of the tens of thousands of ordinary
 * calls a frontend makes, and putting those in the stream would bury the ones
 * that matter.
 *
 * @returns {object|null} the record, or null when this call is not one
 */
function httpCallRecord(ctx, node, env, { isNew, callee, line, routeArg, summaries, binding }) {
  const { relFile, top, moduleEnclosing } = ctx;
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
  if (callee === null || !(goesThroughABinding || carriesUrl || platformSink !== null || injected !== null)) {
    return null;
  }
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
  rec.method = methodOf(callee, summaries, platformSink, globalClient);
  // The functions this call HANDS OVER, left off when there are none so a
  // frontend's ordinary call records do not each grow an empty list.
  const refs = fnRefsOf(ctx, node.arguments, env);
  if (refs.length > 0) rec.fnRefs = refs;
  return rec;
}

/** One call, read for what it sends and for what it hands over. */
export function visitCall(ctx, node, env) {
  const {
    lineOf, emit, packs, calleeOf, bindingOf, summarizeArg, anyPackSeesARoute, eachChild,
  } = ctx;
  const visit = (n, e) => ctx.visit(n, e);
  const isNew = node.type === 'NewExpression';
  const calleeNode = node.callee;
  const line = lineOf(node);
  const callee = !isNew && calleeNode && calleeNode.type === 'Import'
    ? null : (calleeNode ? calleeOf(calleeNode) : null);

  const early = beforeARequest(ctx, node, env, { isNew, calleeNode, callee, line });
  if (early !== null) {
    if (early.record !== null) emit(early.record, line);
    if (early.walkArgs) for (const a of node.arguments) visit(a, env);
    return;
  }

  const argNodes = node.arguments.slice(0, 3);
  // AN OBJECT A ROUTER PACK READS AS A ROUTE IS NOT A REQUEST. Its `path` or
  // `url` is where the browser goes, not where a request is sent, and the
  // route reader has already recorded it as one.
  const routeArg = argNodes.map((a) => anyPackSeesARoute(packs, a));
  const summaries = argNodes.map((a) => summarizeArg(a));
  const binding = callee ? bindingOf(callee.root, env.scope, env.classInfo) : null;

  // A NAVIGATION IS NOT A REQUEST (RM59). `router.push('/auth/login')` swaps
  // the component the browser is already showing; nothing leaves the machine.
  // Read before any of the HTTP rules, because every one of them would see a
  // path-shaped argument and call it a request.
  const navigation = navigationOf(ctx, { isNew, callee, binding, env, argNodes, line });
  if (navigation !== null) {
    emit(navigation, line);
    for (const a of node.arguments) visit(a, env);
    return;
  }

  const rec = httpCallRecord(ctx, node, env, { isNew, callee, line, routeArg, summaries, binding });
  if (rec !== null) emit(rec, line);

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

// ---------------------------------------------------------------------------
// A URL BUILT ON A NAMED CONSTANT IS STILL A URL (RM58)
//
// `const POSTS_URL = '/board-service/api/v1/posts'` at the top of a file, and
// `axios.get(`${POSTS_URL}/${id}`)` twelve lines below it, is the commonest way
// a TypeScript frontend writes its API calls. Read literally the template is
// `{*}/{*}`, which names no route, so every one of those calls used to place no
// edge at all — on the MSA template measured for this round, 73 of 217 call
// sites.
//
// So a hole that is a NAME THIS FILE CAN FOLLOW TO TEXT is filled in, and the
// record says what was put where: `substituted` names the constant and its
// value, and the text as written stays on the record beside it. What is filled
// in is only ever a literal the source states, which is why the substitution is
// a fact and not a guess.
//
// WHAT STAYS A HOLE, and what it is then called:
//   parameter  a name local to the enclosing function: one it was handed, or a
//              `let` of its own. Neither is stated where the call is written
//   env        `process.env.X`, `import.meta.env.X`, or a constant bound to
//              one. An env value is a DEPLOYMENT fact, not a source fact, and
//              filling it in would state something this repository does not
//   call       a call. What it returns is a program, not a spelling
//   import     a name another module exports. One file cannot follow it, so the
//              record carries the specifier and the bridge finishes the job
//   unknown    anything else
// ---------------------------------------------------------------------------

/** Whether a name is the deployment's environment rather than this source's. */
const isEnvName = (name) => /^(process\.env|import\.meta\.env)(\.|$)/.test(name);

/** What one NAME holds, followed as far as this file states it. */
function reduceName(ctx, name, scope, seen) {
  const { top, summarizeArg } = ctx;
  if (seen.has(name)) return { value: null, kind: 'unknown', name };
  seen.add(name);
  if (isEnvName(name)) return { value: null, kind: 'env', name };
  const dot = name.indexOf('.');
  if (dot > 0) {
    const root = name.slice(0, dot);
    const member = name.slice(dot + 1);
    const c = top.constants.get(root);
    const outer = scope.find(root);
    const statedRoot = outer === null || !outer.mutable.has(root);
    if (c && c.members && c.members.has(member) && statedRoot) {
      return { value: c.members.get(member), from: 'same-file' };
    }
    if (outer && !outer.isModule) return { value: null, kind: 'parameter', name };
    if (top.imports.has(root)) return { value: null, kind: 'import', name, ...top.imports.get(root) };
    return { value: null, kind: 'unknown', name };
  }
  const found = scope.find(name);
  // A `let` is not bound to the literal beside it: the next line may assign it
  // again, and `let t = "0"; if (…) t = params.t` is real code. Only a `const`
  // states a value, so only a `const` is followed.
  const stated = found === null || !found.mutable.has(name);
  if (found && !found.isModule) {
    const init = found.names.get(name);
    // A parameter has no initializer at all: it is the caller's value.
    if (!init || !stated) return { value: null, kind: 'parameter', name };
    return reduceSummary(ctx, summarizeArg(init), scope, seen, name);
  }
  const c = top.constants.get(name);
  if (c && typeof c.value === 'string' && stated) return { value: c.value, from: 'same-file' };
  if (top.imports.has(name)) return { value: null, kind: 'import', name, ...top.imports.get(name) };
  if (found && found.isModule && found.names.get(name) && stated) {
    return reduceSummary(ctx, summarizeArg(found.names.get(name)), scope, seen, name);
  }
  return { value: null, kind: 'unknown', name };
}

/** The same question asked of what a name was ASSIGNED, one summary at a time. */
function reduceSummary(ctx, summary, scope, seen, name) {
  if (!summary) return { value: null, kind: 'unknown', name };
  if (summary.kind === 'string') return { value: summary.value, from: 'same-file' };
  if (summary.kind === 'ident') return reduceName(ctx, summary.name, scope, seen);
  if (summary.kind === 'member') return reduceName(ctx, [summary.root, ...summary.path].join('.'), scope, seen);
  if (summary.kind === 'template') {
    // A constant built out of other constants. It counts only when it reduces
    // ALL the way: half a path is not a path.
    const inner = fillHoles(ctx, summary, scope, seen);
    if (inner.dynamicParts === 0) return { value: inner.template, from: 'same-file' };
    return { value: null, kind: inner.holes.length > 0 ? inner.holes[0].kind : 'unknown', name };
  }
  return { value: null, kind: 'unknown', name };
}

/**
 * One template with every hole this file can fill filled in.
 *
 * @returns {{template:string, dynamicParts:number, holes:object[], substituted:object[], written:(string|null)}}
 */
export function fillHoles(ctx, summary, scope, seen = null) {
  const written = summary.template;
  const holes = Array.isArray(summary.holes) ? summary.holes : [];
  const parts = written.split('{*}');
  // The template and its hole list have to line up, or nothing is filled in:
  // a `{*}` written in the source itself would put the values in the wrong
  // places, and a wrong path is worse than a hole.
  if (holes.length === 0 || parts.length - 1 !== holes.length) {
    return {
      template: written, dynamicParts: summary.dynamicParts, holes: [], substituted: [], written: null,
    };
  }
  const out = [];
  const substituted = [];
  const remaining = [];
  for (let i = 0; i < holes.length; i += 1) {
    out.push(parts[i]);
    const hole = holes[i];
    const red = hole.kind === 'name'
      ? reduceName(ctx, hole.name, scope, seen === null ? new Set() : new Set(seen))
      : { value: null, kind: hole.kind === 'call' ? 'call' : 'unknown', ...(hole.name ? { name: hole.name } : {}) };
    if (typeof red.value === 'string') {
      out.push(red.value);
      if (!substituted.some((s) => s.name === hole.name)) {
        substituted.push({ name: hole.name, value: red.value, from: red.from });
      }
      continue;
    }
    out.push('{*}');
    const { value, ...rest } = red;
    remaining.push(rest);
  }
  out.push(parts[parts.length - 1]);
  return {
    template: out.join(''),
    dynamicParts: remaining.length,
    holes: remaining,
    substituted,
    written: substituted.length > 0 ? written : null,
  };
}

/** Every URL one argument can be, or null when this file cannot say. */
export function resolveSummary(ctx, summary, scope, via, depth, substitute = true) {
  const { top, summarizeArg } = ctx;
  if (!summary) return null;
  if (summary.kind === 'string') return [{ template: summary.value, dynamicParts: 0, via }];
  if (summary.kind === 'template') {
    if (!substitute) return [{ template: summary.template, dynamicParts: summary.dynamicParts, via }];
    return [{ ...fillHoles(ctx, summary, scope), via }];
  }
  if (summary.kind === 'ternary') {
    const out = [];
    for (const c of summary.candidates) {
      const r = resolveSummary(ctx, c, scope, via, depth, substitute);
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
      return resolveSummary(ctx, summarizeArg(found.names.get(summary.name)), scope, via, depth - 1, substitute);
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
  url.resolved = foldSubstitutions(url, resolved);
  if (query !== null) url.query = query;
  if (absolute !== null) url.absolute = absolute;
  return url;
}

/**
 * What the substitution did, moved off the candidates and onto the url (RM58).
 *
 * ONE candidate keeps nothing of its own: its holes and its substitutions are
 * the url's, and saying it twice would only make the shard bigger. A TERNARY is
 * two possible requests, and the holes of one are not the holes of the other,
 * so there each candidate keeps its own list and the url carries the merged
 * substitutions for a reader to count.
 */
function foldSubstitutions(url, resolved) {
  const substituted = [];
  for (const r of resolved) {
    for (const s of r.substituted ?? []) {
      if (!substituted.some((x) => x.name === s.name && x.value === s.value)) substituted.push(s);
    }
  }
  const one = resolved.length === 1;
  if (one && typeof resolved[0].written === 'string') url.written = resolved[0].written;
  if (substituted.length > 0) url.substituted = substituted;
  if (one && (resolved[0].holes ?? []).length > 0) url.holes = resolved[0].holes;
  return resolved.map((r) => {
    const { holes, substituted: mine, written, ...rest } = r;
    if (one) return rest;
    return {
      ...rest,
      ...((holes ?? []).length > 0 ? { holes } : {}),
      ...(typeof written === 'string' ? { written } : {}),
    };
  });
}

/**
 * A NEXACRO TRANSACTION IS A CALL TO THE BACKEND (RM56).
 *
 * `this.transaction(id, "svcurl::userSelectVO.do", inDs, outDs, args, cb)` is
 * the native form; every product wraps it, and the wrapper takes an options
 * object instead: `Iject.transaction(this, oDatas, cb)` with
 * `oDatas = { svcid: "search", sController: "userSelectVO.do", … }`. Both send
 * the same request, so both are read here, and the wrapper's NAME is never part
 * of the rule: what makes this a transaction is the method called and a url in
 * a place a transaction puts one.
 *
 * WHERE THE URL IS LOOKED FOR, in order:
 *   the second argument   the native call's own url position, when it is a
 *                         string literal
 *   an options object     any argument that IS an object literal, or a name
 *                         this file binds to one, under one of the keys the
 *                         declaration `TRANSACTION_URL_KEYS` lists
 *
 * A transaction whose url is neither is RECORDED with no url and counted: it is
 * a request this lane knows happens and cannot follow, which is a different
 * thing from no request at all.
 *
 * @returns {Object|null} the call record, or null when this is not a transaction
 */
function nexacroTransactionOf(ctx, node, env, callee, line) {
  const { relFile, moduleEnclosing, nexacro } = ctx;
  if (!nexacro || callee === null) return null;
  const method = callee.path.length > 0 ? callee.path[callee.path.length - 1] : callee.root;
  if (method !== 'transaction') return null;
  const args = node.arguments ?? [];
  let written = null;
  let from = null;
  const second = args[1];
  if (second && second.type === 'StringLiteral') {
    written = second.value;
    from = 'argument';
  } else {
    const scoped = nexacro.objects.get(env.func ? env.func.node : null) ?? null;
    const atModule = nexacro.objects.get(null) ?? null;
    for (const a of args) {
      const object = a && a.type === 'ObjectExpression' ? nexacroUrlKeyOf(a)
        : a && a.type === 'Identifier'
          ? ((scoped && scoped.get(a.name)) ?? (atModule && atModule.get(a.name)) ?? null)
          : null;
      if (object === null) continue;
      written = object.value;
      from = object.key;
      break;
    }
  }
  const rec = {
    kind: 'call', file: relFile, line,
    enclosing: env.func ? (env.func.finalName ?? env.func.baseName) : moduleEnclosing,
    callee,
    binding: null,
    args: [],
    url: null,
    method: { value: TRANSACTION_METHOD, from: 'nexacro-transaction' },
    platformSink: null,
    nexacro: { from: from ?? 'unreadable' },
  };
  if (env.func) rec.__enclosingEntry = env.func;
  if (written === null) return rec;
  const hit = resolveTransactionUrl(written, nexacro.services);
  rec.nexacro.written = written;
  if (hit.prefix !== null) {
    rec.nexacro.prefix = hit.prefix;
    if (hit.base !== null) rec.nexacro.base = hit.base;
  }
  rec.url = { arg: { kind: 'literal', value: written }, resolved: [{ template: hit.full }] };
  return rec;
}

/** One object property's key, when it is written plainly enough to read. */
function propertyKeyName(p) {
  const k = p.key;
  if (!k) return null;
  if (k.type === 'Identifier' && p.computed !== true) return k.name;
  if (k.type === 'StringLiteral') return k.value;
  return null;
}

/** The first URL key an object literal writes a string under, or null. */
function nexacroUrlKeyOf(objectNode) {
  for (const key of TRANSACTION_URL_KEYS) {
    for (const p of objectNode.properties ?? []) {
      if (p.type !== 'ObjectProperty') continue;
      if (propertyKeyName(p) !== key) continue;
      if (p.value && p.value.type === 'StringLiteral') return { key, value: p.value.value };
    }
  }
  return null;
}

/**
 * Every options object this file binds to a name, so a transaction handed
 * `oDatas` can be read.
 *
 * The scan is over the WHOLE file rather than a scope: a Nexacro form declares
 * one options object per handler, each in its own function, and reading them
 * all up front is what lets the call rule stay one lookup. The FIRST
 * declaration by position keeps a name, so a file that reuses one gets the same
 * answer whatever order the walk takes.
 *
 * @returns {Map<string,{key:string, value:string}>}
 */
export function nexacroObjects(ctx, program) {
  const out = new Map(); // enclosing function node (null = the module) -> name -> hit
  const put = (owner, name, node) => {
    const hit = nexacroUrlKeyOf(node);
    if (hit === null) return;
    if (!out.has(owner)) out.set(owner, new Map());
    const byName = out.get(owner);
    if (!byName.has(name)) byName.set(name, hit);
  };
  const walk = (n, owner) => {
    if (!n || typeof n !== 'object') return;
    const inner = (n.type === 'FunctionExpression' || n.type === 'FunctionDeclaration'
      || n.type === 'ArrowFunctionExpression' || n.type === 'ObjectMethod'
      || n.type === 'ClassMethod') ? n : owner;
    if (n.type === 'VariableDeclarator' && n.id && n.id.type === 'Identifier'
      && n.init && n.init.type === 'ObjectExpression') put(owner, n.id.name, n.init);
    if (n.type === 'AssignmentExpression' && n.left && n.left.type === 'Identifier'
      && n.right && n.right.type === 'ObjectExpression') put(owner, n.left.name, n.right);
    ctx.eachChild(n, (child) => walk(child, inner));
  };
  for (const stmt of program.body) walk(stmt, null);
  return out;
}
