// uses.mjs — what a named function does with each object a name holds, asked
// of every place the name is read.
//
// WHAT THIS MODULE OWNS. `writes.mjs` settles a wrapper step only while nothing
// changes the object it hands on (review 3, R2). Review 4 (W-3) showed why a
// list of the ways code WRITES an object cannot settle that: a destructuring
// assignment, `arr = [option]`, `box = { cfg }`, `(flag ? cfg : x).url = …` each
// write it in a shape no list named, and the hop was taken as settled. So the
// question is asked the other way round (default-deny). Every place a name is
// read is classified, and it is a READ only in a shape this module positively
// knows leaves the object as it was: a key read (`cfg.url` as a value), a test,
// an operand, a spread copy, a destructuring declaration, a read-only builtin.
// A write it recognizes says under which key (`cfg.url = …`, `delete cfg.url`,
// `({ u: cfg.url } = …)`, `Object.assign(cfg, …)`), and a method called on the
// object writes any key. EVERY OTHER place hands the object on (`handed`), with
// the node it went to: code this reader does not follow may change it.
//
// WHAT IT MUST NEVER KNOW ABOUT: clients, wrappers, other files.

import { bare, keyName } from './ast.mjs';

/** Syntax that only wraps a value: what it holds is what is inside. */
const TRANSPARENT = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSTypeAssertion', 'TSNonNullExpression', 'ParenthesizedExpression']);

/** Keys under which a name is a declaration or a label, never a read of what it holds. */
const DECLARED_AT = new Set(['id', 'params', 'param', 'label', 'local', 'exported', 'imported', 'meta']);

/** Keys that hold a type, not a value. */
const TYPE_KEYS = new Set(['typeAnnotation', 'typeParameters', 'returnType', 'superTypeParameters', 'typeArguments', 'implements']);

/** Where a value is only looked at: a test, an operand, text. */
const READ_AT = new Map([
  ['IfStatement', 'test'], ['WhileStatement', 'test'], ['DoWhileStatement', 'test'], ['ForStatement', 'test'],
  ['ConditionalExpression', 'test'], ['SwitchStatement', 'discriminant'], ['SwitchCase', 'test'],
  ['TemplateLiteral', 'expressions'], ['ExpressionStatement', 'expression'], ['BinaryExpression', '*'],
]);

/** `Object.x(o)`, `Reflect.x(o)`, `JSON.x(o)` that only read what they are handed. */
const READ_ONLY_BUILTINS = new Set([
  'Object.keys', 'Object.values', 'Object.entries', 'Object.getOwnPropertyNames', 'Object.getOwnPropertyDescriptor',
  'Object.getOwnPropertyDescriptors', 'Object.hasOwn', 'Object.isFrozen', 'Object.isSealed', 'Object.is',
  'Reflect.has', 'Reflect.ownKeys', 'Reflect.get', 'Reflect.getOwnPropertyDescriptor', 'JSON.stringify', 'Array.isArray',
]);

const isMember = (n) => n && (n.type === 'MemberExpression' || n.type === 'OptionalMemberExpression');
const isCall = (n) => n && (n.type === 'CallExpression' || n.type === 'OptionalCallExpression' || n.type === 'NewExpression');

/** The key a member expression reads: its name, a string written as one, or `*`. */
function memberKey(m) {
  const p = m.property;
  if (!m.computed && p && p.type === 'Identifier') return p.name;
  return p && p.type === 'StringLiteral' ? p.value : '*';
}

/** `Object.assign`, as the text a builtin callee is spelled with, or null. */
function builtinName(call) {
  const c = call.callee;
  if (!isMember(c) || c.computed || !c.object || c.object.type !== 'Identifier' || !c.property) return null;
  return ['Object', 'Reflect', 'JSON', 'Array'].includes(c.object.name) ? `${c.object.name}.${c.property.name}` : null;
}

/** The index in `stack` of the node that holds what the node at `i` holds, past wrappers that change nothing. */
function throughWrappers(stack, i) {
  let at = i;
  while (at > 0 && TRANSPARENT.has(stack[at - 1].node.type)) at -= 1;
  return at;
}

/**
 * Whether the node at `i` is WRITTEN by where it stands: the left of an
 * assignment, `++`, `delete`, the target of a for-in or for-of, or a place in
 * a pattern that an assignment writes into.
 */
function isWriteTarget(stack, i) {
  const { key } = stack[i];
  const p = stack[i - 1] ? stack[i - 1].node : null;
  if (!p) return false;
  if (p.type === 'AssignmentExpression' || p.type === 'ForInStatement' || p.type === 'ForOfStatement') return key === 'left';
  if (p.type === 'UpdateExpression') return true;
  if (p.type === 'UnaryExpression') return p.operator === 'delete';
  const inPattern = (p.type === 'ObjectProperty' && key === 'value' && stack[i - 2]?.node.type === 'ObjectPattern')
    || p.type === 'ArrayPattern' || p.type === 'RestElement' || (p.type === 'AssignmentPattern' && key === 'left');
  return inPattern && isWriteTarget(stack, p.type === 'ObjectProperty' ? i - 2 : i - 1);
}

/** A member chain rooted at the node at `i`: what the outermost access does to the key right under the name. */
function memberUse(stack, i) {
  const key = memberKey(stack[i - 1].node);
  let top = i - 1;
  let depth = 1;
  for (; top > 0 && isMember(stack[top - 1].node) && stack[top].key === 'object'; top -= 1) depth += 1;
  top = throughWrappers(stack, top);
  if (isWriteTarget(stack, top)) {
    const p = stack[top - 1].node;
    const literal = depth === 1 && p.type === 'AssignmentExpression' && p.operator === '=' ? stringOf(p.right) : null;
    return { use: 'write', key, value: literal };
  }
  // `cfg.move()` runs with `this` as the object, so it may write any key; a
  // call on a value read under a key changes that value, never which one sits there.
  const p = stack[top - 1] ? stack[top - 1].node : null;
  if (depth === 1 && isCall(p) && stack[top].key === 'callee') return { use: 'write', key: '*', value: null };
  return { use: 'read' };
}

/** A string written as one: a literal, or a template with nothing in it. */
function stringOf(node) {
  const n = bare(node);
  if (n && n.type === 'StringLiteral') return n.value;
  if (n && n.type === 'TemplateLiteral' && n.expressions.length === 0) return n.quasis.map((q) => q.value.cooked).join('');
  return null;
}

/** `Object.assign(cfg, { method: 'POST' })` writes those keys; any other source writes keys nobody states. */
function assignedKeys(call) {
  const sources = call.arguments.slice(1).map(bare);
  const literal = sources.every((s) => s && s.type === 'ObjectExpression' && s.properties.every((p) => p.type === 'ObjectProperty' && keyName(p) !== null));
  if (!literal) return [{ use: 'write', key: '*', value: null }];
  return sources.flatMap((s) => s.properties).map((p) => ({ use: 'write', key: keyName(p), value: stringOf(p.value) }));
}

/** The name handed to a call as an argument: a read-only builtin reads it, a writing one writes it, any other call gets it. */
function argumentUse(call, argIndex) {
  const b = builtinName(call);
  if (b === 'Object.assign') return argIndex === 0 ? assignedKeys(call) : [{ use: 'read' }];
  if (b !== null && READ_ONLY_BUILTINS.has(b)) return [{ use: 'read' }];
  if (b !== null && argIndex === 0 && /^(Object|Reflect)\.(define|set|delete)/.test(b)) return [{ use: 'write', key: '*', value: null }];
  return [{ use: 'handed', site: call }];
}

/** The call an object or array literal is written straight into as an argument, or the literal itself. */
function holderSite(stack, at) {
  const lit = throughWrappers(stack, at);
  const p = stack[lit - 1] ? stack[lit - 1].node : null;
  return isCall(p) && stack[lit].key === 'arguments' ? p : stack[at].node;
}

/** Where the value may flow on to unchanged: a branch of `? :`, `||`, `??`, `&&`, the last of a sequence, `await`. */
function flowsOn(stack, i) {
  const p = stack[i - 1].node;
  const { key } = stack[i];
  if (p.type === 'ConditionalExpression') return key !== 'test';
  if (p.type === 'LogicalExpression' || p.type === 'AwaitExpression') return true;
  return p.type === 'SequenceExpression' && p.expressions[p.expressions.length - 1] === stack[i].node;
}

/**
 * WHAT THE PLACE AT `i` DOES WITH THE OBJECT: a list of uses, each `read`,
 * `write` (with the key, and the string when one is put there), `alias` (a
 * `const` that holds the same object) or `handed` (with the node it went to).
 * `flowed` says the value came through `? :` or `||`, so a name it is kept in
 * may hold something else and is not an alias.
 */
function useAt(stack, i, flowed = false) {
  const at = throughWrappers(stack, i);
  if (at === 0) return [{ use: 'read' }];
  const { node: p } = stack[at - 1];
  const { key } = stack[at];
  if (flowsOn(stack, at)) return useAt(stack, at - 1, true);
  if (isMember(p) && key === 'object') return [memberUse(stack, at)];
  // `x[cfg]`, `!cfg`, `typeof cfg`: the value is only looked at.
  if (isMember(p) || p.type === 'UnaryExpression') return [{ use: 'read' }];
  // A tagged template hands what it holds to its tag, which is a call.
  if (p.type === 'TemplateLiteral' && stack[at - 2]?.node.type === 'TaggedTemplateExpression') return [{ use: 'handed', site: stack[at - 2].node }];
  if (READ_AT.has(p.type) && (READ_AT.get(p.type) === '*' || READ_AT.get(p.type) === key)) return [{ use: 'read' }];
  if (p.type === 'SequenceExpression') return [{ use: 'read' }];
  if (p.type === 'SpreadElement') return spreadUse(stack, at - 1);
  if (isCall(p) && key === 'arguments') return argumentUse(p, p.arguments.indexOf(stack[at].node));
  return storedUse(stack, at, flowed);
}

/** `{ ...cfg }` and `[...cfg]` copy it; `f(...cfg)` hands it to `f`. */
function spreadUse(stack, s) {
  const holder = stack[s - 1] ? stack[s - 1].node : null;
  if (holder && (holder.type === 'ObjectExpression' || holder.type === 'ArrayExpression')) return [{ use: 'read' }];
  return isCall(holder) ? argumentUse(holder, -1) : [{ use: 'handed', site: stack[s].node }];
}

/** The object kept in a name, a container or another object: an alias only for a `const` given it whole. */
function storedUse(stack, at, flowed) {
  const { node: p } = stack[at - 1];
  const { key } = stack[at];
  if (p.type === 'VariableDeclarator' && key === 'init') {
    if (p.id.type !== 'Identifier') return [{ use: 'read' }];
    const kind = stack[at - 2] ? stack[at - 2].node.kind : null;
    return kind === 'const' && !flowed ? [{ use: 'alias', to: p.id.name }] : [{ use: 'handed', site: p }];
  }
  if (p.type === 'AssignmentExpression' && key === 'right' && (p.left.type === 'ObjectPattern' || p.left.type === 'ArrayPattern')) {
    return [{ use: 'read' }];
  }
  if (p.type === 'ObjectProperty' && key === 'value') return [{ use: 'handed', site: holderSite(stack, at - 2) }];
  if (p.type === 'ArrayExpression') return [{ use: 'handed', site: holderSite(stack, at - 1) }];
  return [{ use: 'handed', site: p }];
}

/** Whether the Identifier at the top of `stack` names something rather than reads what a name holds. */
function isDeclaration(stack) {
  const i = stack.length - 1;
  const { key } = stack[i];
  const p = stack[i - 1] ? stack[i - 1].node : null;
  if (!p) return true;
  if (isMember(p) && key === 'property' && !p.computed) return true;
  if (key === 'key' && !p.computed) return true;
  if (DECLARED_AT.has(key)) return true;
  // A name inside a pattern that declares names, `const { url } = option`.
  for (let j = i - 1; j > 0; j -= 1) {
    const n = stack[j].node.type;
    if (n !== 'ObjectPattern' && n !== 'ArrayPattern' && n !== 'ObjectProperty' && n !== 'RestElement' && n !== 'AssignmentPattern') {
      return DECLARED_AT.has(stack[j + 1].key);
    }
    if (n === 'AssignmentPattern' && stack[j + 1].key === 'right') return false;
    if (n === 'ObjectProperty' && stack[j + 1].key === 'key') return false;
  }
  return false;
}

/**
 * EVERY USE a function body makes of the objects its names hold, handed to
 * `note(name, use, cond)`: `cond` says the place may not run (under an `if`, a
 * loop, a `&&`, a callback: `branching`). A name that is not a declaration is
 * a use; `this` is not a name and is left to the reader that asks about it.
 */
export function eachUse(body, branching, note) {
  const stack = [];
  const walk = (node, key, cond) => {
    stack.push({ node, key });
    if (node.type === 'Identifier' && !isDeclaration(stack)) {
      for (const u of useAt(stack, stack.length - 1)) note(node.name, u, cond);
    }
    const inner = cond || branching.has(node.type);
    for (const k of Object.keys(node)) {
      if (TYPE_KEYS.has(k) || k === 'loc' || k === 'extra' || k.endsWith('Comments')) continue;
      const v = node[k];
      if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') walk(c, k, inner); } else if (v && typeof v.type === 'string') walk(v, k, inner);
    }
    stack.pop();
  };
  if (body && typeof body.type === 'string') walk(body, null, false);
}
