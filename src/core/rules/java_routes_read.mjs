// java_routes_read.mjs — how a Java method that builds functional routes is read, one call at a time, in the words a rule pack gives.
//
// The Java worker records the body of every method declared to return a
// RouterFunction as a tree (adapters/java/JavaFacts.java, `routeFunction`). This
// file walks that tree the way the framework runs it: a builder is started, each
// verb call on it adds a route, a nest puts the routes inside it under a
// prefix, and the finished value is what the method returns. WHICH call does
// which is not written here: every name comes from the vocabulary a
// `java.route-function` rule declares (src/core/rules/kinds/java_route_function.mjs).
//
// It reads one class on its own, as its file states it. What it cannot read it
// says, with a code and the text as written, and never guesses: a path in a
// variable, a handler that is a lambda doing more than calling one method, a
// value built by a call the pack does not name, a statement that is not a call
// on a builder. Which Java method a handler reference means (a field's type, a
// parameter's, an import) is the Java bridge's question, asked with the whole
// tree of types in hand (src/adapters/java/functional_routes.mjs).

/** The argument kinds each role of a form accepts, as the worker writes them. */
const ROLE_ACCEPTS = Object.freeze({
  path: new Set(['str', 'plus', 'id', 'sel']),
  predicate: new Set(['call', 'id', 'sel']),
  handler: new Set(['ref', 'lambda', 'id', 'sel']),
  routes: new Set(['call', 'lambda', 'ref', 'id', 'sel']),
  operation: new Set(['lambda', 'ref', 'id', 'sel']),
  method: new Set(['sel', 'id']),
  any: null,
});

/** Why a part of a route could not be read. The codes are what an example names. */
export const UNREAD = Object.freeze({
  'path-not-literal': 'the path is not a literal, or a constant of this class',
  'no-path': 'the route names no path pattern, so it answers every path under its prefix',
  'handler-not-one-call': 'the handler is a lambda that does more than call one method',
  'handler-not-read': 'the handler is held in a variable, or returned by a call',
  'predicate-not-read': 'the request predicate is not one the pack names, or is held in a variable',
  'call-not-named': 'the value is built by a call the pack does not name',
  'value-in-variable': 'the value is held in a variable this method does not build',
  'helper-with-arguments': 'the routes come from a helper that is handed arguments, so what it builds depends on them',
  'statement-not-read': 'a statement that is not a call on a route builder: what it builds is not read',
  'value-not-read': 'the value the method returns is not one this rule reads',
  'cut': 'the method is larger than the worker records whole',
});

export const UNKNOWN = '<unknown>';

const lastSegment = (s) => String(s).slice(String(s).lastIndexOf('.') + 1);

/** A Spring path from its parts: one leading slash, single slashes, no trailing one but the root's. */
export function joinSpringPath(...parts) {
  const joined = `/${parts.filter((p) => typeof p === 'string' && p !== '').join('/')}`.replace(/\/+/g, '/');
  return joined.length > 1 ? joined.replace(/\/$/, '') : joined;
}

/**
 * The entry of a vocabulary table that a call with these arguments is, and the
 * argument each role got: the first form, in the pack's order, whose arity is
 * the call's and whose every role accepts its argument. When none does, the
 * first form of that arity is taken as it stands, so an argument of a kind no
 * role reads (a path a call returns) is said as that part not read, rather
 * than the whole call being one the pack does not name.
 */
export function matchForm(entries, name, args, isStatic, receiverName, kindOf = (a) => a?.k) {
  const named = entries.filter((entry) => entry.names.has(name) && (entry.on !== null) === isStatic
    && !(isStatic && receiverName !== null && !entry.on.has(lastSegment(receiverName))));
  for (const lenient of [false, true]) {
    for (const entry of named) {
      if (entry.forms === '*') return { entry, roles: {} };
      const form = entry.forms.find((f) => f.length === args.length
        && (lenient || f.every((role, i) => ROLE_ACCEPTS[role] === null || ROLE_ACCEPTS[role].has(kindOf(args[i])))));
      if (form) return { entry, roles: Object.fromEntries(form.map((role, i) => [role, args[i]])) };
    }
  }
  return null;
}

/** The value of a name this method or class holds as a string constant, else null. */
function constantOf(node, ctx) {
  if (node.k === 'id') {
    const local = ctx.scope?.get(node.v);
    if (local) return local.node?.k === 'str' && typeof local.node.v === 'string' ? local.node.v : null;
    return ctx.constants[node.v] ?? null;
  }
  if (node.k === 'sel') {
    const [head, tail, extra] = node.v.split('.');
    return extra === undefined && head === ctx.ownSimple ? ctx.constants[tail] ?? null : null;
  }
  return null;
}

/** A path argument: `{path}` or `{unread, text}`. */
export function readPath(node, ctx) {
  if (node.k === 'str') return node.v === null ? { unread: 'path-not-literal', text: '<a string longer than the worker records>' } : { path: node.v };
  const constant = constantOf(node, ctx);
  if (constant !== null) return { path: constant };
  if (node.k === 'plus') {
    const parts = node.a.map((p) => (p.k === 'str' ? p.v : constantOf(p, ctx)));
    if (parts.every((p) => typeof p === 'string')) return { path: parts.join('') };
  }
  return { unread: 'path-not-literal', text: writtenOf(node) };
}

/** A tree node as the source roughly wrote it, for a diagnostic. */
export function writtenOf(node) {
  if (!node) return '';
  switch (node.k) {
    case 'str': return node.v === null ? '"..."' : JSON.stringify(node.v);
    case 'id': case 'sel': return node.v;
    case 'this': case 'super': return node.k;
    case 'plus': return node.a.map(writtenOf).join(' + ');
    case 'ref': return `${writtenOf(node.r)}::${node.n}`;
    case 'call': return `${node.r ? `${writtenOf(node.r)}.` : ''}${node.n}(${node.a.length > 0 ? '...' : ''})`;
    case 'lambda': return `(${node.p.join(', ')}) -> ...`;
    case 'new': return `new ${node.t}(...)`;
    default: return `<${node.k}${node.t ? ` ${node.t}` : ''}>`;
  }
}

/** A request predicate: `{verb, path}` (either may be null), or `{unread, text}`. */
export function readPredicate(node, ctx) {
  const local = node.k === 'id' ? ctx.scope?.get(node.v)?.node : null;
  if (local) return readPredicate(local, { ...ctx, scope: new Map([...ctx.scope].filter(([k]) => k !== node.v)) });
  if (node.k !== 'call') return { unread: 'predicate-not-read', text: writtenOf(node) };
  const { vocab } = ctx;
  if (node.r && node.r.k === 'call') {
    const hit = matchForm(vocab.predicates, node.n, node.a, false, null);
    if (!hit || hit.entry.does !== 'and') return { unread: 'predicate-not-read', text: writtenOf(node) };
    return andPredicates(readPredicate(node.r, ctx), readPredicate(hit.roles.predicate, ctx), node);
  }
  const hit = matchForm(vocab.predicates, node.n, node.a, true, node.r ? writtenOf(node.r) : null);
  if (!hit) return { unread: 'predicate-not-read', text: writtenOf(node) };
  const path = hit.roles.path ? readPath(hit.roles.path, ctx) : { path: null };
  if (path.unread) return path;
  const verb = hit.entry.verb ?? (hit.roles.method ? vocab.methods.get(hit.roles.method.v) ?? null : null);
  if (hit.roles.method && verb === null) return { unread: 'predicate-not-read', text: writtenOf(node) };
  return { verb, path: path.path, rule: hit.entry.rule };
}

/**
 * Two predicates that must both hold: each may name a verb and a path, but not
 * two different ones. One side this rule cannot read can only narrow what the
 * other allows, so the other side still says where the route is, and the
 * unread side rides along to be said.
 */
function andPredicates(a, b, node) {
  if (a.unread && b.unread) return a;
  if (a.unread || b.unread) {
    const [known, lost] = a.unread ? [b, a] : [a, b];
    return { ...known, narrowedBy: [...(known.narrowedBy ?? []), lost.text] };
  }
  if ((a.verb && b.verb && a.verb !== b.verb) || (a.path !== null && b.path !== null)) {
    return { unread: 'predicate-not-read', text: writtenOf(node) };
  }
  return { verb: a.verb ?? b.verb ?? null, path: a.path ?? b.path, rule: a.rule ?? b.rule };
}

/** Who a receiver is: this class, its superclass, a name the method binds, or a name the bridge resolves. */
function receiverOf(r, ctx) {
  if (r === null || r.k === 'this') return { via: 'this' };
  if (r.k === 'super') return { via: 'super' };
  if (r.k === 'id') {
    const bound = ctx.scope.get(r.v);
    if (bound) return bound.param ? { via: 'param', name: r.v, type: bound.type } : { via: 'local', name: r.v, type: bound.type };
    return { via: 'name', name: r.v };
  }
  if (r.k === 'sel') return r.v.startsWith('this.') && r.v.split('.').length === 2 ? { via: 'name', name: r.v.slice(5) } : { via: 'type', name: r.v };
  return null;
}

/** Whether every call among a lambda's arguments only reads its own parameter (`request.pathVariable("id")`). */
function readsOnly(nodes, param) {
  const rootOf = (n) => (n && n.k === 'call' && n.r ? rootOf(n.r) : n);
  return nodes.every((n) => {
    if (!n || typeof n !== 'object') return true;
    if (n.k === 'lambda' || n.k === 'other' || n.k === 'cut' || n.k === 'new') return false;
    if (n.k === 'call') {
      const root = rootOf(n);
      return root && root.k === 'id' && root.v === param && readsOnly(n.a, param);
    }
    return n.k === 'plus' ? readsOnly(n.a, param) : true;
  });
}

/** A handler: `{handler:{via, name?, type?, method, lambda?}}` or `{unread, text}`. */
export function readHandler(node, ctx) {
  if (node.k === 'ref') {
    const recv = receiverOf(node.r, ctx);
    return recv ? { handler: { ...recv, method: node.n } } : { unread: 'handler-not-read', text: writtenOf(node) };
  }
  if (node.k !== 'lambda') return { unread: 'handler-not-read', text: writtenOf(node) };
  const body = node.e ?? (node.b && node.b.length === 1 && node.b[0].s === 'return' ? node.b[0].e : null);
  const [param] = node.p;
  const single = node.p.length === 1 && body && body.k === 'call' && (body.r === null || body.r.k !== 'call') && readsOnly(body.a, param);
  const recv = single ? receiverOf(body.r, ctx) : null;
  if (!recv || (recv.via === 'name' && recv.name === param)) return { unread: 'handler-not-one-call', text: writtenOf(node) };
  return { handler: { ...recv, method: body.n, lambda: true } };
}

/** The operation id an operation consumer names (`builder -> builder.operationId("ListPosts")...`), or null. */
export function readOperationId(node, ctx) {
  if (!node || node.k !== 'lambda' || node.p.length !== 1) return null;
  const [param] = node.p;
  const names = ctx.vocab.operationId;
  const stmts = node.e ? [{ s: 'expr', e: node.e }] : (node.b ?? []);
  // The builder keeps the id it was given LAST: the last statement, and in a
  // chain the outermost call. A last call whose argument is not a literal
  // leaves the id not known, never the one an earlier call named; so does a
  // later statement that may call it where this reader does not follow (under
  // an if, in a loop, nested in another call's argument).
  for (const s of stmts.slice().reverse()) {
    const found = s.s === 'expr' ? operationIdIn(s.e, param, names) : undefined;
    if (found !== undefined) return found;
    if (mayCallAny(s, names)) return null;
  }
  return null;
}

/** Whether a recorded statement or expression calls one of `names` anywhere inside it, read or not. */
function mayCallAny(node, names) {
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some((x) => mayCallAny(x, names));
  if ((node.k === 'call' && names.has(node.n)) || (node.c ?? []).some((n) => names.has(n))) return true;
  return Object.values(node).some((v) => typeof v === 'object' && mayCallAny(v, names));
}

/** The id the outermost operation-id call of one chain on `param` names: a string, null when it is not a literal, undefined when none is called. */
function operationIdIn(chain, param, names) {
  let last;
  for (let n = chain; n && n.k === 'call'; n = n.r) {
    if (last === undefined && names.has(n.n)) last = n.a.length === 1 && n.a[0].k === 'str' && typeof n.a[0].v === 'string' ? n.a[0].v : null;
    if (n.r && n.r.k === 'id') return n.r.v === param ? last : undefined;
  }
  return undefined;
}
