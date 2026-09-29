// tsuses.mjs — where a local that holds a call's value goes after that, read from one file alone.
//
// A query builder held in a local (`const qb = repo.createQueryBuilder('u')`)
// is read as the steps written on it, and whether that is all of them depends
// on every other place the local is used. The reader cannot list the shapes
// that let a value escape (`new Pager(qb)`, `[qb]`, `f(on ? qb : null)`, `const
// q2 = qb.where(...)` of a builder that returns itself): there are too many.
// So it lists the one shape that is safe, and records every other one: a use
// of such a local is safe only as the receiver of a call whose value, and the
// value of every call chained on it, is thrown away (`qb.andWhere(...);`).
// Any other use is a `use` record: `how: 'value'` when it is the receiver of
// calls whose last value goes somewhere (with the step names, so the bridge,
// which knows which step runs the query, can tell rows from the builder), and
// `how: 'other'` for anything else. A write of the local is `how: 'write'`,
// `self` when it is given a call on itself (`q = q.andWhere(...)`).
// Nothing here knows a framework, and nothing here looks at another file.

import { eachChild, isFunctionNode } from '../web/lib/ast.mjs';

const WRAPPERS = new Set(['TSAsExpression', 'TSNonNullExpression', 'TSSatisfiesExpression', 'TSTypeAssertion', 'ParenthesizedExpression', 'AwaitExpression']);
const isMember = (n) => n && (n.type === 'MemberExpression' || n.type === 'OptionalMemberExpression');
const isCall = (n) => n && (n.type === 'CallExpression' || n.type === 'OptionalCallExpression');
const lineOf = (n) => (n.loc ? n.loc.start.line : null);

function unwrap(node) {
  let n = node;
  while (n && WRAPPERS.has(n.type)) n = n.expression ?? n.argument;
  return n;
}

/** A member's name as written, or `*` when it is computed. */
const nameOf = (m) => (!m.computed && m.property.type === 'Identifier' ? m.property.name : m.property.type === 'StringLiteral' ? m.property.value : '*');

/** The identifier a call chain starts at (`q` of `q.a().b()`), or null. */
function chainRoot(node) {
  let cur = unwrap(node);
  for (;;) {
    if (isCall(cur)) cur = unwrap(cur.callee);
    else if (isMember(cur)) cur = unwrap(cur.object);
    else return cur && cur.type === 'Identifier' ? cur : null;
  }
}

/** The locals the file gives a call's value, by where each is declared. */
function heldLocals(ast, sc) {
  const held = new Set();
  const note = (id, value) => {
    const v = unwrap(value);
    const at = id && id.type === 'Identifier' ? sc.local(id)?.at : null;
    if (at && (isCall(v) || (v && v.type === 'ConditionalExpression'))) held.add(at);
  };
  const visit = (node) => {
    if (node.type === 'VariableDeclarator' && node.init) note(node.id, node.init);
    if (node.type === 'AssignmentExpression' && node.operator === '=') note(node.left, node.right);
    eachChild(node, visit);
  };
  visit(ast.program);
  return held;
}

/**
 * Whether a node's value is thrown away, through any await or TypeScript
 * around it: an expression statement's, or one given back to the local it was
 * called on (`q = q.andWhere(...)`), which its write record says.
 */
function discarded(stack, i, self) {
  let j = i;
  while (j > 0 && WRAPPERS.has(stack[j - 1].node.type)) j -= 1;
  const above = stack[j - 1]?.node;
  return Boolean(above) && (above.type === 'ExpressionStatement' || (above.type === 'AssignmentExpression' && stack[j].key === 'right' && self(above.left)));
}

/** Whether `stack[k]` is the receiver of a call: the object of a member that is the callee of the call above it. */
const receiverAt = (stack, k) => k >= 2 && stack[k].key === 'object' && isMember(stack[k - 1].node) && stack[k - 1].key === 'callee' && isCall(stack[k - 2].node);

/**
 * One reference of a local, with the nodes above it (`stack[i]` is the
 * reference, each entry `{node, key}` with the key it sits under in the one
 * above): nothing when it is a call receiver whose chain's value is thrown
 * away, else what the `use` record says of it.
 */
function useOf(stack, i, self) {
  if (!receiverAt(stack, i)) return { how: 'other' };
  const steps = [nameOf(stack[i - 1].node)];
  let top = i - 2;
  while (receiverAt(stack, top)) {
    steps.push(nameOf(stack[top - 1].node));
    top -= 2;
  }
  return discarded(stack, top, self) ? null : { how: 'value', steps };
}

/** A write of a tracked local: `self` when its value is a call chain on the local itself. */
function writeOf(node, sc, at) {
  const root = isCall(unwrap(node.right)) ? chainRoot(node.right) : null;
  return { how: 'write', ...(root && sc.local(root)?.at === at ? { self: true } : {}) };
}

/**
 * Every use of a local that holds a call's value other than a call on it whose
 * value is thrown away, as `{kind: 'use', file, at, how, steps?, self?, line}`.
 */
export function useRecords(file, ast, sc) {
  const held = heldLocals(ast, sc);
  if (held.size === 0) return [];
  const out = [];
  const stack = [];
  const visit = (node, key) => {
    stack.push({ node, key });
    const at = node.type === 'Identifier' ? sc.local(node)?.at : null;
    if (at && held.has(at) && isReference(stack[stack.length - 2]?.node, key)) {
      const parent = stack[stack.length - 2]?.node;
      const self = (target) => target?.type === 'Identifier' && sc.local(target)?.at === at;
      const u = parent?.type === 'AssignmentExpression' && key === 'left' ? writeOf(parent, sc, at) : useOf(stack, stack.length - 1, self);
      if (u) out.push({ kind: 'use', file, at, ...u, line: lineOf(node) });
    }
    // A type says nothing about where a value goes.
    eachChild(node, (c, k) => { if (k !== 'typeAnnotation' && k !== 'returnType' && k !== 'typeParameters') visit(c, k); });
    stack.pop();
  };
  visit(ast.program, null);
  return out;
}

/** Whether an identifier under `parent` at `key` refers to a value: not a declaration, a parameter, a member's name or a property key. */
function isReference(parent, key) {
  if (!parent) return false;
  if (parent.type === 'VariableDeclarator' && key === 'id') return false;
  if (isFunctionNode(parent) && key === 'params') return false;
  if ((isMember(parent) || parent.type === 'ObjectProperty' || parent.type === 'ClassProperty') && (key === 'property' || key === 'key') && !parent.computed) return false;
  return true;
}
