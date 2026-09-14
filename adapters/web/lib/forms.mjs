// forms.mjs — a form submitted from script is a request (RM60).
//
// WHAT THIS MODULE OWNS: the one idiom every eGovFrame page is written in, and
// the several spellings of it.
//
//     document.listForm.action = "<c:url value='/updateSampleView.do'/>";
//     document.listForm.submit();
//
// Nothing about that is an HTTP client, so no rule in `calls.mjs` sees it, and
// nothing about it is markup, so no rule in `templates.mjs` sees it either. It
// is still a request to a controller of this same application, written where a
// single-page app would write `axios.post(...)`.
//
// HOW IT IS READ. Three things are collected as the walk goes past them — an
// address assigned to a form's `action`, a method assigned to the same form,
// and a `submit()` on it — and each carries the RECEIVER AS WRITTEN as its key.
// `document.listForm`, `varFrom` and `$('#listForm')` are three forms as far as
// this rule is concerned, and two mentions of the same text are one form. After
// the file is read, each `submit()` is paired with the nearest `action` before
// it IN THE SAME SCOPE (the enclosing function, or the module's own body). A
// submit whose own scope assigned no action sends what the `<form>` element's
// markup says, because a page reloads on every submit and another function's
// assignment is long gone by then. An `action` with no `submit()` after it is a
// form the USER submits with a button, whose address the template reader
// already has.
//
// WHERE THE METHOD COMES FROM, in order: assigned in the same scope before the
// submit, else the `method` of the `<form>` element the name resolves to
// (Spring's `<form:form>` sends POST, HTML's `<form>` sends GET), else nothing,
// and the evidence says the form element was not found in this file.
//
// ONE FILE IS ALL IT SEES. Which route answers the address is the bridge's
// question, as it is for every other call.
//
// WHAT IT MUST NEVER KNOW ABOUT: the graph, the routes, the other files.

import { calleeOf, summarizeArg } from './ast.mjs';
import { VERBS } from './calls.mjs';
import { templateUrlOf } from './templates.mjs';

/** The evidence rule every form-submit record carries, worker and bridge alike. */
export const FORM_SUBMIT_RULE = 'form-submit';

/** How far a name is followed to the expression that found the form. */
const NAME_DEPTH = 2;

/**
 * THE FORM AS THE SOURCE WRITES IT: the text two mentions have to agree on.
 *
 * It is deliberately textual. What makes `varFrom.action = …` and
 * `varFrom.submit()` the same form is that the code says the same thing twice,
 * not that this worker worked out what `varFrom` holds — and the four spellings
 * below are all one project writes.
 *
 * @returns {string|null} null when the receiver is not one of the shapes
 */
export function formReceiverText(node) {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') {
    const c = calleeOf(node);
    return c === null ? null : [c.root, ...c.path].join('.');
  }
  if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') {
    const c = node.callee ? calleeOf(node.callee) : null;
    const arg = (node.arguments ?? [])[0];
    if (c === null || !arg || arg.type !== 'StringLiteral') return null;
    return `${[c.root, ...c.path].join('.')}('${arg.value}')`;
  }
  return null;
}

/**
 * THE NAME OR ID the form element carries, when the receiver says which one.
 *
 * The ways a page reaches a form, and every one of them names it in the text:
 * `document.listForm`, `document.forms['listForm']`, `document.all['listForm']`,
 * `document.getElementById('listForm')` and jQuery's `$('#listForm')`. A name
 * bound to one of those is followed to it, and `a || b` (a page's fallback for
 * an old browser) names whatever its first half names. A form handed in as a
 * parameter names nothing, and the method then has no form element to come from.
 *
 * @returns {string|null}
 */
export function formElementName(node, scope, depth = 0) {
  if (!node || depth > NAME_DEPTH) return null;
  if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') return memberFormName(node);
  if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') return callFormName(node);
  if (node.type === 'LogicalExpression' && (node.operator === '||' || node.operator === '??')) {
    return formElementName(node.left, scope, depth + 1) ?? formElementName(node.right, scope, depth + 1);
  }
  return initOf(node, scope, (init) => formElementName(init, scope, depth + 1));
}

/** `document.x`, `document.forms['x']`, `document.all['x']`: the name after `document`. */
function memberFormName(node) {
  const c = calleeOf(node);
  if (c === null || c.root !== 'document') return null;
  if (c.path.length === 1) return c.path[0];
  if (c.path.length === 2 && (c.path[0] === 'forms' || c.path[0] === 'all') && c.path[1] !== '*') return c.path[1];
  return null;
}

/** `document.getElementById('x')` and jQuery's `$('#x')`: the id the call is handed. */
function callFormName(node) {
  const c = node.callee ? calleeOf(node.callee) : null;
  const arg = (node.arguments ?? [])[0];
  if (c === null || !arg || arg.type !== 'StringLiteral') return null;
  if (c.path.length > 0 && c.path[c.path.length - 1] === 'getElementById') return arg.value;
  if (c.path.length === 0 && arg.value.startsWith('#')) return arg.value.slice(1);
  return null;
}

/** What a name was bound to where it was declared, handed to `then`, or null. */
function initOf(node, scope, then) {
  if (!node || node.type !== 'Identifier' || !scope) return null;
  const found = scope.find(node.name);
  const init = found === null ? null : (found.names.get(node.name) ?? null);
  return init === null ? null : then(init);
}

/**
 * WHETHER THE PAGE BUILT THIS FORM ITSELF: `document.createElement('form')`,
 * directly or through the name it was bound to. Such a form has no markup to
 * read a method from, and HTML says what it sends when nobody assigns one: GET.
 *
 * @returns {boolean}
 */
export function formCreated(node, scope, depth = 0) {
  if (!node || depth > NAME_DEPTH) return false;
  if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') {
    const c = node.callee ? calleeOf(node.callee) : null;
    const arg = (node.arguments ?? [])[0];
    return c !== null && c.path[c.path.length - 1] === 'createElement'
      && (c.root === 'document' || c.path.includes('document'))
      && arg !== undefined && arg.type === 'StringLiteral' && arg.value.toLowerCase() === 'form';
  }
  return initOf(node, scope, (init) => formCreated(init, scope, depth + 1)) === true;
}

/** One event, stamped so that two runs over the same file pair them the same way. */
function push(ctx, event) {
  const events = ctx.formEvents;
  if (!Array.isArray(events)) return;
  events.push({ ...event, seq: events.length });
}

/**
 * `form.action = <address>` — the half of the idiom that says WHERE.
 *
 * @returns {boolean} whether this assignment was one
 */
export function formActionAssignment(ctx, node, env) {
  const left = node.left;
  if (!left || (left.type !== 'MemberExpression' && left.type !== 'OptionalMemberExpression')) return false;
  const c = calleeOf(left);
  if (c === null || c.path.length === 0 || c.path[c.path.length - 1] !== 'action') return false;
  const key = formReceiverText(left.object);
  if (key === null) return false;
  push(ctx, {
    what: 'action', key, line: ctx.lineOf(node),
    url: ctx.buildUrl(summarizeArg(node.right), env.scope),
    name: formElementName(left.object, env.scope),
    created: formCreated(left.object, env.scope),
    func: env.func ?? null,
  });
  return true;
}

/** `form.method = 'get'` — the half that says HOW, when the page says it. */
export function formMethodAssignment(ctx, node, env) {
  const left = node.left;
  if (!left || (left.type !== 'MemberExpression' && left.type !== 'OptionalMemberExpression')) return false;
  const c = calleeOf(left);
  if (c === null || c.path.length === 0 || c.path[c.path.length - 1] !== 'method') return false;
  const right = node.right;
  if (!right || right.type !== 'StringLiteral') return false;
  const value = right.value.trim().toUpperCase();
  if (!VERBS.has(value)) return false;
  const key = formReceiverText(left.object);
  if (key === null) return false;
  push(ctx, { what: 'method', key, line: ctx.lineOf(node), value, func: env.func ?? null });
  return true;
}

/**
 * `form.submit()` and jQuery's `$('#form').attr('action', url)`, the two calls
 * this rule is written on.
 *
 * @returns {boolean} whether this call was one of them
 */
export function formCall(ctx, node, env, callee) {
  if (callee === null || !Array.isArray(callee.path) || callee.path.length === 0) {
    return jqueryFormCall(ctx, node, env);
  }
  if (callee.path[callee.path.length - 1] !== 'submit') return jqueryFormCall(ctx, node, env);
  const key = formReceiverText(node.callee.object);
  if (key === null) return false;
  push(ctx, {
    what: 'submit', key, line: ctx.lineOf(node),
    name: formElementName(node.callee.object, env.scope),
    created: formCreated(node.callee.object, env.scope),
    func: env.func ?? null,
    enclosing: env.func ? (env.func.finalName ?? env.func.baseName) : ctx.moduleEnclosing,
  });
  return true;
}

/** jQuery writes the same two halves as method calls: `.attr('action', url)`, `.submit()`. */
function jqueryFormCall(ctx, node, env) {
  const calleeNode = node.callee;
  if (!calleeNode || (calleeNode.type !== 'MemberExpression' && calleeNode.type !== 'OptionalMemberExpression')) return false;
  const method = !calleeNode.computed && calleeNode.property && calleeNode.property.type === 'Identifier'
    ? calleeNode.property.name : null;
  const key = formReceiverText(calleeNode.object);
  if (key === null) return false;
  const args = node.arguments ?? [];
  if (method === 'submit' && args.length === 0) {
    push(ctx, {
      what: 'submit', key, line: ctx.lineOf(node), name: formElementName(calleeNode.object, env.scope),
      func: env.func ?? null,
      enclosing: env.func ? (env.func.finalName ?? env.func.baseName) : ctx.moduleEnclosing,
    });
    return true;
  }
  if ((method !== 'attr' && method !== 'prop') || args.length < 2) return false;
  if (!args[0] || args[0].type !== 'StringLiteral' || args[0].value !== 'action') return false;
  push(ctx, {
    what: 'action', key, line: ctx.lineOf(node),
    url: ctx.buildUrl(summarizeArg(args[1]), env.scope),
    name: formElementName(calleeNode.object, env.scope),
    func: env.func ?? null,
  });
  return true;
}

/** The events of one file, in the order the page runs them. */
const inOrder = (events) => events.slice().sort((a, b) => a.line - b.line || a.seq - b.seq);

/**
 * WHERE THE METHOD CAME FROM, for one pairing.
 *
 * @param {object[]} assigned  the method assignments on this form in this scope, before the submit
 * @param {object|undefined} el  the `<form>` element the name resolves to, when there is one
 * @param {boolean} created  whether the page built the form with `document.createElement`
 * @returns {{value:(string|null), from:(string|null), source:string}}
 */
function methodOf(assigned, el, created) {
  if (assigned.length > 0) {
    return { value: assigned[assigned.length - 1].value, from: 'form-assigned', source: 'assigned' };
  }
  if (el !== undefined) return { value: el.method, from: 'form-element', source: 'form element' };
  if (created) return { value: 'GET', from: 'form-created', source: 'created by the page' };
  return { value: null, from: null, source: 'not found' };
}

/**
 * One `<form>` table, looked up by the names a script can reach it through.
 *
 * Spring's `<form:form modelAttribute="groupManage">` with no `id` renders
 * `id="groupManage"`: the tag's reference documentation shows it, and it is what
 * `document.getElementById('groupManage')` finds in the browser. So the model
 * attribute is a key exactly when the tag left the id to it.
 */
export function formElementIndex(elements) {
  const out = new Map();
  for (const el of elements ?? []) {
    const rendered = el.tag === 'form:form' && !el.id ? (el.model ?? null) : null;
    for (const key of [el.name, el.id, rendered]) {
      if (typeof key === 'string' && key !== '' && !out.has(key)) out.set(key, el);
    }
  }
  return out;
}

/**
 * The address a form element's own markup names, as the url a call carries.
 * The same reader the markup form goes through, so a static asset, an address
 * with a host and an empty `action` are no address at all.
 */
function elementUrlOf(el) {
  if (el === undefined || typeof el.action !== 'string') return null;
  const url = templateUrlOf(el.action);
  if (url === null) return null;
  const holes = (url.match(/\{\*\}/g) ?? []).length;
  return {
    arg: { kind: 'string', value: el.action },
    resolved: [{ template: url, dynamicParts: holes, via: holes > 0 ? 'template' : 'literal' }],
  };
}

/**
 * THE ADDRESS ONE SUBMIT SENDS, and where it came from.
 *
 * ONE SCOPE IS ALL A SUBMIT READS. `fnSearch()` that only submits does not send
 * the address `linkPage()` assigned three lines above it: a page reloads on
 * every submit, so what a function that assigns nothing sends is the `action`
 * the form element carries in the markup. The scope is the function NODE (the
 * walk's entry for it), never its name, so two functions a page happens to
 * name alike are two scopes; the module's own body is one scope.
 *
 * @returns {{action:(object|null), url:(object|null), actionFrom:(string|null), assigned:object[], el:(object|undefined), created:boolean}}
 */
function addressOf(ordered, i, elements) {
  const submit = ordered[i];
  const mine = (e) => e.key === submit.key && e.func === submit.func;
  let at = -1;
  for (let j = i - 1; j >= 0; j -= 1) {
    if (ordered[j].what === 'action' && mine(ordered[j])) { at = j; break; }
  }
  const action = at < 0 ? null : ordered[at];
  const name = (action && action.name) ?? submit.name ?? null;
  const el = name === null ? undefined : elements.get(name);
  // A method assigned ANYWHERE before the submit in this scope counts, before the
  // address or after it: `f.method = 'post'; f.action = url; f.submit()` is how a
  // page writes a form it built itself.
  const assigned = ordered.slice(0, i).filter((e) => e.what === 'method' && mine(e));
  const created = submit.created === true || (action !== null && action.created === true);
  if (action !== null) return { action, url: action.url ?? null, actionFrom: 'assigned', assigned, el, name, created };
  const url = elementUrlOf(el);
  return { action: null, url, actionFrom: url === null ? null : 'form element', assigned, el, name, created };
}

/** The call record one submit is, once its address is known. */
function submitRecord({ relFile, submit, found, moduleEnclosing }) {
  const method = methodOf(found.assigned, found.el, found.created);
  return {
    kind: 'call', file: relFile, line: submit.line,
    enclosing: submit.enclosing ?? moduleEnclosing,
    callee: { shape: 'form', root: FORM_SUBMIT_RULE, path: [], name: FORM_SUBMIT_RULE },
    binding: null,
    args: [],
    url: found.url,
    method: method.value === null ? null : { value: method.value, from: method.from },
    platformSink: null,
    formSubmit: {
      form: submit.key,
      ...(found.name === null ? {} : { name: found.name }),
      actionFrom: found.actionFrom ?? 'not found',
      ...(found.action === null ? {} : { actionLine: found.action.line }),
      methodFrom: method.source,
    },
    ...(submit.func ? { __enclosingEntry: submit.func } : {}),
  };
}

/**
 * THE CALL RECORDS one file's form idiom produces.
 *
 * A submit with no address anywhere — no action assigned in its own scope, and
 * no `<form>` element with a usable `action` — is still recorded, with no url,
 * so the bridge can count a request that happens and that no edge can carry.
 *
 * @param {{relFile:string, events:object[], elements:Map<string,object>, moduleEnclosing:string}} a
 * @returns {{order:number, line:number, rec:object}[]}
 */
export function formSubmitRecords({ relFile, events, elements, moduleEnclosing }) {
  const ordered = inOrder(events);
  const out = [];
  let ordinal = 2e6;
  for (let i = 0; i < ordered.length; i += 1) {
    const submit = ordered[i];
    if (submit.what !== 'submit') continue;
    const found = addressOf(ordered, i, elements);
    ordinal += 1;
    out.push({ order: ordinal, line: submit.line, rec: submitRecord({ relFile, submit, found, moduleEnclosing }) });
  }
  return out;
}
