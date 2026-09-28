// java_routes_eval.mjs — the value a route-building method returns, walked the way the framework builds it.
//
// A builder is started, each verb call on it adds a route, a nest puts what is
// inside it under a prefix, a call that combines two router functions adds the
// second's routes to the first's, and a filter or an attribute leaves them as
// they were. The vocabulary that says which call does which is the rule's
// (src/core/rules/kinds/java_route_function.mjs); the pieces of one route (its
// path, its predicate, its handler) are read in ./java_routes_read.mjs.
//
// A method of the same class that builds routes and takes no argument is read
// where it is called, under the prefix of the place it is called from, and is
// then not a separate set of routes: that is how a helper is mounted.

import {
  UNKNOWN, joinSpringPath, matchForm, readHandler, readOperationId, readPath, readPredicate, writtenOf,
} from './java_routes_read.mjs';

const unknown = (code, text) => ({ t: 'unknown', routes: [], code, text });
/** How deep one helper may call another before the read stops: a helper that calls itself would not end. */
const HELPER_DEPTH = 4;

/**
 * A route's path: the pattern argument when the call has one, else the
 * predicate's. A predicate beside a pattern can only narrow the route, never
 * move it, so one this rule cannot read is said and the pattern still stands.
 */
function pathOfCall(roles, pred, node, ctx) {
  if (roles.path) {
    const own = readPath(roles.path, ctx);
    if (own.unread) return { unread: own.unread, text: own.text };
    if (pred?.unread) ctx.notes.push({ code: pred.unread, text: pred.text, line: node.l ?? null });
    return pred && !pred.unread && pred.path !== null ? { unread: 'path-not-literal', text: `${own.path} and ${pred.path}: two paths for one route` } : { path: own.path };
  }
  if (pred?.unread) return { unread: pred.unread, text: pred.text };
  // No pattern at all: the route answers every path under where it stands.
  // Under a nest that is the nest's own path (and more); at the top it is
  // every path, which is no endpoint (see `settle`).
  return pred && pred.path !== null ? { path: pred.path } : { path: '', anyPath: true, text: writtenOf(node) };
}

/** A route read off one verb call, with its path relative to where the call stands. */
function routeOf(entry, roles, node, ctx) {
  const unread = [];
  const pred = roles.predicate ? readPredicate(roles.predicate, ctx) : null;
  for (const text of pred?.narrowedBy ?? []) ctx.notes.push({ code: 'predicate-not-read', text, line: node.l ?? null });
  const path = pathOfCall(roles, pred, node, ctx);
  if (path.unread) unread.push({ code: path.unread, text: path.text });
  const h = roles.handler ? readHandler(roles.handler, ctx) : { unread: 'handler-not-read', text: writtenOf(node) };
  if (h.unread) unread.push({ code: h.unread, text: h.text });
  return {
    verb: entry.verb ?? (pred && !pred.unread ? pred.verb : null) ?? 'ANY', parts: path.unread ? null : [path.path], handler: h.handler ?? null,
    operationId: readOperationId(roles.operation, ctx), line: node.l ?? null, rule: entry.rule, unread,
    ...(path.anyPath ? { anyPath: path.text } : {}),
  };
}

/** The same routes, each under one more prefix; a prefix not read makes the path of each not read. */
function underPrefix(routes, prefix) {
  return routes.map((r) => (prefix.path === undefined
    ? { ...r, parts: null, anyPath: undefined, unread: [...r.unread, { code: prefix.unread, text: prefix.text }] }
    : { ...r, parts: r.parts === null ? null : [prefix.path, ...r.parts], anyPath: undefined, ...(r.anyPath ? { underNest: true } : {}) }));
}

/** A route with no pattern that no nest put under a path answers every path: that is no endpoint, and it is said. */
export function settle(routes) {
  return routes.map(({ anyPath, ...r }) => (anyPath
    ? { ...r, parts: null, unread: [...r.unread, { code: 'no-path', text: anyPath }] }
    : r));
}

/** What a nest's prefix is: a path argument, or the path of a predicate argument. */
function prefixOf(roles, ctx) {
  if (roles.path) {
    const p = readPath(roles.path, ctx);
    return p.unread ? { unread: p.unread, text: p.text } : { path: p.path };
  }
  const pred = roles.predicate ? readPredicate(roles.predicate, ctx) : { unread: 'predicate-not-read', text: '' };
  if (pred.unread) return { unread: pred.unread, text: pred.text };
  for (const text of pred.narrowedBy ?? []) ctx.notes.push({ code: 'predicate-not-read', text, line: null });
  return pred.verb || pred.path === null ? { unread: 'predicate-not-read', text: writtenOf(roles.predicate) } : { path: pred.path };
}

/** One call applied to the value it is called on. */
function apply(hit, node, recv, ctx) {
  const { entry, roles } = hit;
  const kept = recv ?? { t: 'routes', routes: [] };
  switch (entry.does) {
    case 'start': return { t: 'builder', routes: [] };
    case 'keep': return kept;
    // What the builder holds NOW, as a router function: a route added to the builder later is not in it.
    case 'build': return { t: 'routes', routes: [...kept.routes] };
    case 'resources': ctx.notes.push({ code: 'resources', text: writtenOf(node), line: node.l ?? null }); return kept;
    case 'route': return added(kept, [routeOf(entry, roles, node, ctx)]);
    case 'combine': return withInner(kept, routesArg(roles.routes, ctx), (rs) => rs, node, ctx);
    case 'nest': {
      const prefix = prefixOf(roles, ctx);
      return withInner(kept, routesArg(roles.routes, ctx), (rs) => underPrefix(rs, prefix), node, ctx);
    }
    default: return unknown('call-not-named', writtenOf(node));
  }
}

/**
 * Routes added to a value. A builder is ONE object, however many names hold it
 * (`alias = b; alias.GET(...); b.build()`), because each of its calls changes it
 * and returns it: so it is changed in place. A router function is a value, and
 * `and` makes a new one.
 */
function added(kept, routes) {
  if (kept.t !== 'builder') return { t: kept.t, routes: [...kept.routes, ...routes] };
  kept.routes.push(...routes);
  return kept;
}

/** The receiver's routes and an inner value's; an inner value not read is said, and what was read stays. */
function withInner(kept, inner, place, node, ctx) {
  if (inner.t === 'unknown') ctx.notes.push({ code: inner.code, text: inner.text, line: node.l ?? null });
  return added(kept, place(inner.routes));
}

/** Whether a call with no receiver, or a type name as one, is a static call. */
function isStaticReceiver(r, ctx) {
  if (r === null) return true;
  if (r.k === 'id') return !ctx.scope.has(r.v);
  return r.k === 'sel' && !r.v.startsWith('this.');
}

/** An argument's kind for choosing a form: a local stands for what it was initialised with. */
const kindIn = (ctx) => (a) => (a?.k === 'id' ? ctx.scope.get(a.v)?.node?.k ?? a.k : a?.k);

/** The value of an expression: a builder, a router function, or unknown with why. */
export function evalValue(node, ctx) {
  if (!node) return unknown('value-not-read', '');
  if (node.k === 'cut') return unknown('cut', '');
  if (node.k === 'id') return ctx.scope.get(node.v)?.value ?? unknown('value-in-variable', node.v);
  // A supplier of routes, as a helper that returns `Supplier<RouterFunction<…>>` hands one over.
  if (node.k === 'lambda' && node.p.length === 0) return routesArg(node, ctx);
  if (node.k !== 'call') return unknown(node.k === 'new' ? 'call-not-named' : 'value-not-read', writtenOf(node));
  const helper = helperCall(node, ctx);
  if (helper) return helper;
  if (isStaticReceiver(node.r, ctx)) {
    const hit = matchForm(ctx.vocab.calls, node.n, node.a, true, node.r ? writtenOf(node.r) : null, kindIn(ctx));
    return hit ? apply(hit, node, null, ctx) : unknown('call-not-named', writtenOf(node));
  }
  const recv = evalValue(node.r, ctx);
  if (recv.t === 'unknown') return recv;
  const hit = matchForm(ctx.vocab.calls, node.n, node.a, false, null, kindIn(ctx));
  return hit ? apply(hit, node, recv, ctx) : unknown('call-not-named', writtenOf(node));
}

/** A call of a route-building method of this class: read where it is called, or unknown when it takes arguments. */
function helperCall(node, ctx) {
  if (!(node.r === null || node.r.k === 'this') || !ctx.helpers.has(node.n)) return null;
  if (node.a.length > 0) return unknown('helper-with-arguments', writtenOf(node));
  return inlineHelper(node.n, ctx);
}

function inlineHelper(name, ctx) {
  if (ctx.stack.includes(name) || ctx.stack.length > HELPER_DEPTH) return unknown('value-not-read', `${name}(): a helper that calls itself`);
  ctx.inlined.add(name);
  return readBody(ctx.helpers.get(name), { ...ctx, stack: [...ctx.stack, name], scope: new Map() }).value;
}

/** An argument that holds routes: a value, a supplier of one, a builder consumer, or a helper named by reference. */
function routesArg(node, ctx) {
  if (node.k === 'ref') {
    return node.r.k === 'this' && ctx.helpers.has(node.n) ? inlineHelper(node.n, ctx) : unknown('value-not-read', writtenOf(node));
  }
  if (node.k !== 'lambda') return evalValue(node, ctx);
  const scope = new Map(ctx.scope);
  if (node.p.length === 0) {
    const inner = { ...ctx, scope };
    return node.e ? evalValue(node.e, inner) : runBlock(node.b, inner).value;
  }
  if (node.p.length !== 1) return unknown('value-not-read', writtenOf(node));
  // A builder consumer: the parameter is a fresh builder, and what is called on it is what it holds.
  scope.set(node.p[0], { value: { t: 'builder', routes: [] }, builder: true });
  const inner = { ...ctx, scope };
  if (node.e) {
    const v = evalValue(node.e, inner);
    return v.t === 'builder' ? v : scope.get(node.p[0]).value;
  }
  runBlock(node.b, inner);
  return scope.get(node.p[0]).value;
}

/** The root of a call chain: the name or expression the first call is made on. */
function chainRoot(node) {
  let n = node;
  while (n && n.k === 'call' && n.r) n = n.r;
  return n;
}

/**
 * The statements of a body, in order: a local holds what its initializer gives,
 * a call on a builder held in a local adds to it, and the first return is the
 * value. Anything else is said, not read.
 */
export function runBlock(stmts, ctx) {
  let value = null;
  for (const s of stmts ?? []) {
    forgetAssigned(s, ctx);
    if (s.s === 'return') value ??= evalValue(s.e, ctx);
    else runStatement(s, ctx);
  }
  return { value: value ?? unknown('value-not-read', 'nothing is returned') };
}

/** One statement that is not a return: a local bound or assigned, a call on a builder, or something said as not read. */
function runStatement(s, ctx) {
  const said = (text) => ctx.notes.push({ code: 'statement-not-read', text, line: s.l ?? null });
  if (s.s === 'var' || (s.s === 'assign' && ctx.scope.has(s.n))) {
    // The initializer is kept as written too: a local may hold a path or a
    // predicate, not only routes. An assignment replaces both, so a later use
    // reads the value the local holds THERE.
    const type = s.s === 'var' ? s.t ?? null : ctx.scope.get(s.n).type ?? null;
    ctx.scope.set(s.n, { type, node: s.e ?? null, value: s.e ? evalValue(s.e, ctx) : unknown('value-in-variable', s.n) });
  } else if (s.s === 'assign') {
    said(`${s.n} = ${writtenOf(s.e)}`);
  } else if (s.s === 'expr') {
    const root = chainRoot(s.e);
    const bound = root && root.k === 'id' ? ctx.scope.get(root.v) : null;
    if (!(bound && bound.value?.t === 'builder')) return said(writtenOf(s.e));
    const v = evalValue(s.e, ctx);
    if (v.t !== 'builder') ctx.notes.push({ code: v.code ?? 'statement-not-read', text: v.text ?? writtenOf(s.e), line: s.l ?? null });
  } else if (s.s === 'other') {
    said(`a ${String(s.t).toLowerCase().replace(/_/g, ' ')} statement`);
  }
  return undefined;
}

/**
 * A local a statement assigns where this reader does not follow (in a branch,
 * with `+=`, inside an expression) holds a value it cannot name from there on:
 * a path read from it is not read, never read at the value it held before.
 */
function forgetAssigned(s, ctx) {
  for (const name of s.a ?? []) {
    const prev = ctx.scope.get(name);
    if (prev) ctx.scope.set(name, { type: prev.type ?? null, node: null, value: unknown('value-in-variable', name) });
  }
}

/** One route-building method, read: the value it returns, with its own parameters bound by name. */
export function readBody(rec, ctx) {
  const scope = ctx.scope ?? new Map();
  for (const p of rec.params ?? []) scope.set(p.name, { type: p.type ?? null, param: true, value: unknown('value-in-variable', p.name) });
  if (rec.cut) ctx.notes.push({ code: 'cut', text: `${rec.method}()`, line: rec.line ?? null });
  return runBlock(rec.body, { ...ctx, scope });
}

/** A route's path as one string, or UNKNOWN. */
export const pathOfRoute = (r) => (r.parts === null ? UNKNOWN : joinSpringPath(...r.parts));
