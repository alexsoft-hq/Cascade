// Bounded syntax and reference census for source-only constant interpretation.
// This records syntax, never executes a project's code. Unknown uses stay unsafe.
import { eachChild, isFunctionNode } from '../web/lib/ast.mjs';
const WRAPPERS = new Set(['TSAsExpression', 'TSNonNullExpression', 'TSSatisfiesExpression', 'TSTypeAssertion', 'ParenthesizedExpression']);
const unwrap = (n) => { while (n && WRAPPERS.has(n.type)) n = n.expression; return n; };
const unknown = () => ({ k: 'unknown' });
const RUNTIME_TS = new Set(['TSModuleDeclaration', 'TSModuleBlock', 'TSEnumDeclaration', 'TSEnumMember', 'TSParameterProperty', 'TSInstantiationExpression', 'TSExportAssignment']);
const member = (n) => n?.type === 'MemberExpression' && !n.computed && n.property.type === 'Identifier';
const call = (n) => n?.type === 'CallExpression';
const ref = (n, sc) => ({ name: n.name, ...(sc.local(n) ? { at: sc.local(n).at } : {}) });

export function staticValue(node, sc, depth = 0) {
  const n = unwrap(node);
  if (!n || depth > 16) return unknown();
  const next = (v) => staticValue(v, sc, depth + 1);
  if (['StringLiteral', 'NumericLiteral', 'BooleanLiteral'].includes(n.type)) return { k: 'literal', v: n.value };
  if (n.type === 'Identifier') return { k: 'ref', ...ref(n, sc) };
  if (member(n)) return { k: 'member', object: next(n.object), name: n.property.name };
  if (n.type === 'TemplateLiteral') return { k: 'template', parts: n.quasis.map((q) => q.value.cooked), values: n.expressions.map(next) };
  if (n.type === 'ArrayExpression' && n.elements.length <= 256) return { k: 'array', items: n.elements.map((x) => x?.type === 'SpreadElement' ? { k: 'spread', value: next(x.argument) } : next(x)) };
  if (n.type === 'ObjectExpression' && n.properties.length <= 64) {
    const props = {};
    for (const p of n.properties) {
      if (p.type !== 'ObjectProperty' || p.computed) return unknown();
      const name = p.key.name ?? p.key.value;
      if (typeof name !== 'string' || name === '__proto__') return unknown();
      props[name] = next(p.value);
    }
    return { k: 'object', props };
  }
  if (call(n) && member(n.callee) && n.arguments.length <= 3) return { k: 'call', object: next(n.callee.object), method: n.callee.property.name, args: n.arguments.map(next) };
  if (n.type === 'ArrowFunctionExpression' && !n.async && n.params.every((p) => p.type === 'Identifier')) {
    const body = n.body.type === 'BlockStatement' ? n.body.body.length === 1 && n.body.body[0].type === 'ReturnStatement' ? n.body.body[0].argument : null : n.body;
    if (!body) return unknown();
    return { k: 'arrow', params: n.params.map((p) => ref(p, sc)), body: next(body) };
  }
  return unknown();
}

/** Non-mutating array reads whose callbacks are never handed the source array. */
function safeUse(stack) {
  let i = stack.length - 1;
  while (i > 0 && WRAPPERS.has(stack[i - 1].node.type)) i -= 1;
  const parent = stack[i - 1]?.node, key = stack[i].key;
  if (!parent) return false;
  if (parent.type === 'SpreadElement' && stack[i - 2]?.node.type === 'ArrayExpression') return true;
  if (parent.type === 'ForOfStatement' && key === 'right') return true;
  if (parent.type === 'UnaryExpression' && parent.operator === 'typeof') return true;
  if (!member(parent) || key !== 'object') return false;
  const above = stack[i - 2]?.node;
  if (parent.property.name === 'length') return !stack.some((entry, at) => {
    const n = entry.node, childKey = stack[at + 1]?.key;
    return (['AssignmentExpression', 'ForInStatement', 'ForOfStatement'].includes(n.type) && childKey === 'left')
      || n.type === 'UpdateExpression' || (n.type === 'UnaryExpression' && n.operator === 'delete');
  });
  if (!call(above) || stack[i - 1].key !== 'callee') return false;
  const method = parent.property.name;
  if (['includes', 'indexOf', 'lastIndexOf', 'join', 'slice'].includes(method)) return true;
  const max = ['map', 'flatMap', 'filter', 'forEach', 'every', 'some', 'find', 'findIndex'].includes(method) ? 2 : ['reduce', 'reduceRight'].includes(method) ? 3 : 0;
  const fn = unwrap(above.arguments[0]);
  return max > 0 && fn?.type === 'ArrowFunctionExpression' && fn.params.length <= max && fn.params.every((p) => p.type === 'Identifier');
}

/** Visible prototype access is deliberately not followed as a heap graph. */
function prototypeHazards(node) {
  if (node.type !== 'MemberExpression') return [];
  const name = node.computed ? node.property.value : node.property.name;
  if (['prototype', '__proto__', 'getPrototypeOf'].includes(name)) return ['Array', 'String', 'Object'];
  const object = unwrap(node.object);
  if (name !== 'constructor') return [];
  if (object?.type === 'ArrayExpression') return ['Array'];
  if (object?.type === 'StringLiteral' || object?.type === 'TemplateLiteral') return ['String'];
  return object?.type === 'ObjectExpression' ? ['Object'] : [];
}

/** A namespace's values cannot escape through this use when a literal key
 * filter removes their exported name before anyone receives the entries. */
function namespaceFilter(stack, sc) {
  const i = stack.length - 1, entries = stack[i - 1]?.node;
  if (!call(entries) || entries.arguments.length !== 1 || !member(entries.callee)
    || entries.callee.object.type !== 'Identifier' || entries.callee.object.name !== 'Object'
    || entries.callee.property.name !== 'entries' || sc.binding(entries.callee.object)) return null;
  const method = stack[i - 2]?.node, filter = stack[i - 3]?.node;
  if (!member(method) || method.property.name !== 'filter' || !call(filter) || filter.arguments.length !== 1) return null;
  const fn = unwrap(filter.arguments[0]);
  if (fn?.type !== 'ArrowFunctionExpression' || fn.async || fn.params.length !== 1) return null;
  const tuple = fn.params[0];
  if (tuple.type !== 'ArrayPattern' || tuple.elements.length !== 1 || tuple.elements[0]?.type !== 'Identifier') return null;
  const body = fn.body.type === 'BlockStatement' ? fn.body.body.length === 1 && fn.body.body[0].type === 'ReturnStatement' ? unwrap(fn.body.body[0].argument) : null : unwrap(fn.body);
  if (!call(body) || !member(body.callee) || body.callee.property.name !== 'startsWith'
    || body.callee.object.type !== 'Identifier' || body.callee.object.name !== tuple.elements[0].name
    || body.arguments.length !== 1 || body.arguments[0].type !== 'StringLiteral') return null;
  return body.arguments[0].value;
}

/** Visible modifications or escapes of the built-ins defeat the key-filter proof. */
function builtinUnsafe(stack) {
  const i = stack.length - 1, m = stack[i - 1]?.node, above = stack[i - 2]?.node;
  // Calling a static Object/String utility does not hand the constructor out.
  return !((call(m) && stack[i].key === 'callee') || (member(m) && call(above) && stack[i - 1].key === 'callee'));
}

export function staticFacts(ast, sc) {
  const constants = [], uses = [], stack = [], opaqueModules = [], imports = [], exports = [], builtinHazards = [];
  let incomplete = false;
  const visit = (node, key) => {
    if (node.type === 'ImportDeclaration') {
      if (node.importKind !== 'type') for (const spec of node.specifiers) {
        if (spec.importKind === 'type') continue;
        imports.push({ source: node.source.value, name: spec.local.name, imported: spec.type === 'ImportNamespaceSpecifier' ? '*' : spec.type === 'ImportDefaultSpecifier' ? 'default' : spec.imported.name ?? spec.imported.value });
      }
      return;
    }
    if (node.type === 'ExportAllDeclaration' && node.exportKind !== 'type') exports.push({ all: true, source: node.source.value });
    if (node.type === 'ExportNamedDeclaration' && node.exportKind !== 'type') {
      for (const spec of node.specifiers ?? []) if (spec.exportKind !== 'type') exports.push({ name: spec.exported.name ?? spec.exported.value, local: spec.local?.name, source: node.source?.value });
      if (node.declaration?.type === 'VariableDeclaration') for (const d of node.declaration.declarations) if (d.id.type === 'Identifier') exports.push({ name: d.id.name, local: d.id.name });
    }
    if (node.type === 'TSImportEqualsDeclaration') incomplete = true;
    if (node.type.startsWith('TS') && !WRAPPERS.has(node.type) && !RUNTIME_TS.has(node.type)) return;
    stack.push({ node, key });
    builtinHazards.push(...prototypeHazards(node));
    const parent = stack[stack.length - 2]?.node;
    if (call(node) && (node.callee.type === 'Import' || (node.callee.type === 'Identifier' && node.callee.name === 'require'))) opaqueModules.push(node.arguments[0]?.type === 'StringLiteral' ? node.arguments[0].value : '*');
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init && parent?.kind === 'const') {
      constants.push({ ...ref(node.id, sc), value: staticValue(node.init, sc), reassigned: sc.binding(node.id)?.reassigned !== false, line: node.loc?.start.line });
    }
    if (node.type === 'Identifier') {
      const declaration = (parent?.type === 'VariableDeclarator' && key === 'id') || (isFunctionNode(parent) && (key === 'params' || key === 'id')) || (['ClassDeclaration', 'ClassExpression'].includes(parent?.type) && key === 'id');
      const property = (['MemberExpression', 'OptionalMemberExpression'].includes(parent?.type) && key === 'property' && !parent.computed) || (['ObjectProperty', 'ClassProperty', 'ObjectMethod', 'ClassMethod'].includes(parent?.type) && key === 'key' && !parent.computed);
      if (!declaration && !property && parent?.type !== 'ExportSpecifier') {
        if (['eval', 'Function'].includes(node.name) && !sc.binding(node)) incomplete = true;
        const prefix = namespaceFilter(stack, sc);
        uses.push({ ...ref(node, sc), safe: safeUse(stack), ...(prefix !== null ? { keyPrefix: prefix } : {}) });
        if (['Object', 'String', 'Array'].includes(node.name) && !sc.binding(node) && builtinUnsafe(stack)) builtinHazards.push(node.name);
        if (['globalThis', 'global'].includes(node.name) && !sc.binding(node)) {
          let top = stack.length - 1;
          while (top > 0 && WRAPPERS.has(stack[top - 1].node.type)) top -= 1;
          const next = stack[top - 1]?.node;
          const globalMember = next?.type === 'MemberExpression' && stack[top].key === 'object';
          const globalKey = globalMember ? next.computed ? next.property.value : next.property.name : null;
          if (['Object', 'String', 'Array'].includes(globalKey)) builtinHazards.push(globalKey);
          else if (!globalKey) builtinHazards.push('Object', 'String', 'Array');
        }
      }
    }
    eachChild(node, (c, k) => { if (!['typeAnnotation', 'returnType', 'typeParameters', 'superTypeParameters'].includes(k)) visit(c, k); });
    stack.pop();
  };
  visit(ast.program, null);
  return { constants, uses, opaqueModules, imports, exports, builtinHazards, complete: !incomplete && !(ast.errors?.length) };
}
