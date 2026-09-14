// websquare_calls.mjs — the call that sends a WebSquare submission (RM63).
//
// WHAT THIS MODULE OWNS. A page declares `<xf:submission id="sbm_x" action="/x" method="post">` and its
// script sends it by naming it: `$c.sbm.execute(sbm_x)`, `$p.executeSubmission("sbm_x")`,
// or `$c.sbm.executeDynamic({ id, action })` with the address written in the call.
// This module turns such a call into the same `call` record every other request
// in this lane is, with the declaration's address and method on it.
//
// WHAT IT MUST NEVER KNOW ABOUT: the graph and the routes. Which calls send a
// submission is the pack's; what a submission sends is the page's.

import { propOf } from './ast.mjs';

/**
 * THE ENGINE'S OWN NAMESPACE. `WebSquare.core.getConfiguration("/WebSquare/x/@value")`
 * reads the engine's configuration by an XPath, and nothing under `WebSquare.*`
 * sends a request of the application's: that is what a submission is for.
 */
export const ENGINE_GLOBAL = 'WebSquare';

/** Whether a call in a WebSquare page is the engine's own API rather than a request. */
export function isEngineCall(ctx, callee) {
  return !!ctx.websquare && callee !== null && callee.root === ENGINE_GLOBAL;
}

/** The rule every submission call carries, worker and bridge alike. */
export const SUBMISSION_RULE = 'websquare-submission';

/** An object literal a name is bound to where it was declared, or the literal itself. */
function objectOf(node, scope) {
  if (!node) return null;
  if (node.type === 'ObjectExpression') return node;
  if (node.type !== 'Identifier' || !scope) return null;
  const found = scope.find(node.name);
  const init = found === null ? null : (found.names.get(node.name) ?? null);
  return init && init.type === 'ObjectExpression' ? init : null;
}

/** A string property of an object literal, or null. */
function stringProp(obj, key) {
  const v = obj === null ? null : propOf(obj, key);
  return v && v.type === 'StringLiteral' ? v.value : null;
}

/**
 * WHICH SUBMISSION one sending call names, and what it sends.
 *
 * @returns {{id:(string|null), action:(string|null), method:(string|null), from:string}}
 */
function submissionOf(sink, arg, scope, submissions) {
  if (sink.argIs === 'options') {
    const obj = objectOf(arg, scope);
    const id = stringProp(obj, sink.idKey);
    const declared = id === null ? null : (submissions.get(id) ?? null);
    const action = stringProp(obj, sink.actionKey) ?? declared?.action ?? null;
    const verb = (stringProp(obj, sink.methodKey) ?? '').toUpperCase();
    return { id, action, method: verb || declared?.method || null, from: obj === null ? 'unreadable' : 'options' };
  }
  const id = sink.argIs === 'id'
    ? (arg && arg.type === 'StringLiteral' ? arg.value : null)
    : (arg && arg.type === 'Identifier' ? arg.name : arg && arg.type === 'StringLiteral' ? arg.value : null);
  if (id === null) return { id: null, action: null, method: null, from: 'unreadable' };
  const declared = submissions.get(id) ?? null;
  if (declared === null) return { id, action: null, method: null, from: 'undeclared' };
  return { id, action: declared.action, method: declared.method, from: 'declared' };
}

/** The route path an action names, or null when it names none this lane can place. */
function actionPath(action) {
  if (typeof action !== 'string') return null;
  const s = action.trim();
  if (!s.startsWith('/') || s.startsWith('//')) return null;
  return s.split('#')[0].split('?')[0];
}

/**
 * The call record one submission-sending call is, or null when the call sends none.
 *
 * @param {object} ctx  the walk context: `relFile`, `moduleEnclosing`, `websquare`
 *                      (`{submissions, sinks}`)
 */
export function websquareSubmissionOf(ctx, node, env, callee, line) {
  const { relFile, moduleEnclosing, websquare } = ctx;
  if (!websquare || callee === null || callee.path.length === 0) return null;
  const receiver = [callee.root, ...callee.path.slice(0, -1)].join('.');
  const sink = websquare.sinks.get(`${receiver} ${callee.path[callee.path.length - 1]}`) ?? null;
  if (sink === null) return null;
  const found = submissionOf(sink, (node.arguments ?? [])[0], env.scope, websquare.submissions);
  const path = actionPath(found.action);
  const rec = {
    kind: 'call', file: relFile, line,
    enclosing: env.func ? (env.func.finalName ?? env.func.baseName) : moduleEnclosing,
    callee, binding: null, args: [],
    url: path === null ? null : { arg: { kind: 'literal', value: found.action }, resolved: [{ template: path }] },
    method: found.method === null ? null : { value: found.method, from: SUBMISSION_RULE },
    platformSink: null,
    websquare: { submission: found.id, from: found.from, ...(found.action !== null && path === null ? { action: found.action } : {}) },
  };
  if (env.func) rec.__enclosingEntry = env.func;
  return rec;
}
