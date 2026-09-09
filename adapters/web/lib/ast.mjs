// ast.mjs — how this worker reads a syntax tree.
//
// WHAT THIS MODULE OWNS: the primitives every visitor is written on. Walking a
// node's children, reading a property key, describing a callee, summarising an
// argument, and the lexical Scope a name is looked up in. Nothing here decides
// anything about HTTP, routes or screens; it answers "what does this piece of
// syntax say", and the visitors decide what that means.
//
// WHAT IT MUST NEVER KNOW ABOUT: the declaration packs, the record stream, the
// file walk. It imports node:path for one thing — turning a platform path into
// the POSIX spelling every record carries — and nothing else.

import path from 'node:path';

/** The object keys a call's config argument is summarized by. */
const CONFIG_KEYS = ['url', 'method', 'baseURL', 'type', 'data', 'params'];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export const isNode = (v) => v !== null && typeof v === 'object' && typeof v.type === 'string';
const SKIP_KEYS = new Set(['loc', 'range', 'extra', 'leadingComments', 'trailingComments', 'innerComments', 'errors', 'comments', 'tokens']);

export function eachChild(node, fn) {
  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) continue;
    const v = node[key];
    if (Array.isArray(v)) {
      for (const item of v) if (isNode(item)) fn(item, key);
    } else if (isNode(v)) fn(v, key);
  }
}

export const toPosix = (p) => p.split(path.sep).join('/');

/** A property key as written: `a`, `'a'`, `"a"`, `1`. Computed keys give null. */
export function keyName(prop) {
  if (!prop || !prop.key) return null;
  if (prop.computed && prop.key.type !== 'StringLiteral' && prop.key.type !== 'NumericLiteral') return null;
  const k = prop.key;
  if (k.type === 'Identifier') return k.name;
  if (k.type === 'StringLiteral') return k.value;
  if (k.type === 'NumericLiteral') return String(k.value);
  if (k.type === 'PrivateName' && k.id) return `#${k.id.name}`;
  return null;
}

/** The value of an object literal's property, by key name. Null when absent. */
export function propOf(objectNode, name) {
  if (!objectNode || objectNode.type !== 'ObjectExpression') return null;
  for (const p of objectNode.properties) {
    if (p.type !== 'ObjectProperty' && p.type !== 'ObjectMethod') continue;
    if (keyName(p) === name) return p.type === 'ObjectMethod' ? p : p.value;
  }
  return null;
}

export const isFunctionNode = (n) => n && (n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression'
  || n.type === 'ArrowFunctionExpression' || n.type === 'ObjectMethod' || n.type === 'ClassMethod'
  || n.type === 'ClassPrivateMethod');

// ---------------------------------------------------------------------------
// Argument summaries
// ---------------------------------------------------------------------------

/**
 * The one-line description of an argument. It is deliberately lossy: the stream
 * has to stay small enough to ship a 1600-file frontend, and the bridge only
 * ever needs the URL, the method and what the call went through.
 *
 * A `+` concatenation and a template literal collapse to the same shape, with
 * every expression written as `{*}`, because `'/user/' + id` and `` `/user/${id}` ``
 * are the same route with the same hole in it.
 */
export function summarizeArg(node) {
  if (!node) return { kind: 'other' };
  switch (node.type) {
    case 'StringLiteral':
      return { kind: 'string', value: node.value };
    case 'TemplateLiteral':
    case 'BinaryExpression': {
      const t = flattenText(node);
      if (t === null) break;
      if (t.dynamicParts === 0) return { kind: 'string', value: t.template };
      return {
        kind: 'template', template: t.template, dynamicParts: t.dynamicParts,
        ...(t.base === null ? {} : { base: t.base }),
      };
    }
    case 'ConditionalExpression':
      return {
        kind: 'ternary',
        candidates: [summarizeArg(node.consequent), summarizeArg(node.alternate)],
      };
    case 'Identifier':
      return { kind: 'ident', name: node.name };
    case 'MemberExpression':
    case 'OptionalMemberExpression': {
      const c = calleeOf(node);
      if (!c || c.root === null) break;
      return { kind: 'member', root: c.root, path: c.path };
    }
    case 'ObjectExpression': {
      const keys = {};
      for (const key of CONFIG_KEYS) {
        const v = propOf(node, key);
        if (v === null) continue;
        // `data` and `params` are the request BODY. What is in them is the
        // application's business, never a route, so they are recorded as
        // present and not summarized any further.
        keys[key] = (key === 'data' || key === 'params') ? 'present' : summarizeArg(v);
      }
      return { kind: 'object', keys };
    }
    default:
      break;
  }
  return { kind: 'other' };
}

/**
 * A template literal or a `+` chain flattened into `'/a/{*}/b'`. Null when the
 * node is not made of text at all.
 *
 * `base` is the NAME of the hole the text starts with, when it is a plain name
 * (`base_url + '/things/list'`, `` `${api}/things` ``). The template alone says
 * a hole is there and not what it was; a page whose scripts are written against
 * a variable the server filled in with the application's context path cannot be
 * read without it (RM48), and nothing else in the record carries the name.
 *
 * @returns {{template:string, dynamicParts:number, base:(string|null)}|null}
 */
export function flattenText(node) {
  const parts = [];
  let dynamic = 0;
  let base = null;
  const nameOfHole = (n) => {
    if (!n) return null;
    if (n.type === 'Identifier') return n.name;
    if (n.type === 'MemberExpression' || n.type === 'OptionalMemberExpression') {
      const c = calleeOf(n);
      return c && c.root !== null ? [c.root, ...c.path].join('.') : null;
    }
    return null;
  };
  const walkText = (n) => {
    if (!n) return false;
    if (n.type === 'StringLiteral') { parts.push(n.value); return true; }
    if (n.type === 'TemplateLiteral') {
      for (let i = 0; i < n.quasis.length; i += 1) {
        parts.push(n.quasis[i].value.cooked ?? n.quasis[i].value.raw ?? '');
        if (i < n.expressions.length) {
          if (parts.join('') === '') base = nameOfHole(n.expressions[i]);
          parts.push('{*}');
          dynamic += 1;
        }
      }
      return true;
    }
    if (n.type === 'BinaryExpression' && n.operator === '+') {
      return walkText(n.left) && walkText(n.right);
    }
    // Anything else inside a concatenation is a hole.
    if (parts.join('') === '') base = nameOfHole(n);
    parts.push('{*}');
    dynamic += 1;
    return true;
  };
  if (node.type === 'BinaryExpression' && node.operator !== '+') return null;
  if (!walkText(node)) return null;
  return { template: parts.join(''), dynamicParts: dynamic, base };
}

// ---------------------------------------------------------------------------
// Callee descriptors
// ---------------------------------------------------------------------------

/**
 * The shape of a callee (or of any member chain): its root identifier, the
 * chain of names after it, and the last segment.
 *
 * `import.meta.env.X` is spelled with the root `import.meta`, because that IS
 * the identifier as far as anything reading this stream is concerned.
 */
export function calleeOf(node) {
  const segments = [];
  let cur = node;
  for (;;) {
    if (cur.type === 'MemberExpression' || cur.type === 'OptionalMemberExpression') {
      let seg;
      if (!cur.computed && cur.property && cur.property.type === 'Identifier') seg = cur.property.name;
      else if (cur.property && cur.property.type === 'StringLiteral') seg = cur.property.value;
      else seg = '*';
      segments.unshift(seg);
      cur = cur.object;
      continue;
    }
    break;
  }
  let root;
  if (cur.type === 'Identifier') root = cur.name;
  else if (cur.type === 'ThisExpression') root = 'this';
  else if (cur.type === 'MetaProperty') root = `${cur.meta.name}.${cur.property.name}`;
  else if (cur.type === 'Import') root = 'import';
  else return null;
  return {
    shape: segments.length > 0 ? 'member' : 'ident',
    root,
    path: segments,
    name: segments.length > 0 ? segments[segments.length - 1] : root,
  };
}

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

export class Scope {
  constructor(parent, isModule) {
    this.parent = parent;
    this.isModule = isModule === true;
    this.names = new Map(); // name -> init node or null
  }

  declare(name, init) {
    if (typeof name === 'string') this.names.set(name, init ?? null);
  }

  /** The scope that declares `name`, or null. */
  find(name) {
    let s = this;
    while (s) {
      if (s.names.has(name)) return s;
      s = s.parent;
    }
    return null;
  }
}

/** Every binding name a destructuring pattern introduces. */
export function patternNames(node, out = []) {
  if (!node) return out;
  switch (node.type) {
    case 'Identifier': out.push(node.name); break;
    case 'ObjectPattern':
      for (const p of node.properties) {
        if (p.type === 'RestElement') patternNames(p.argument, out);
        else patternNames(p.value, out);
      }
      break;
    case 'ArrayPattern':
      for (const el of node.elements) if (el) patternNames(el, out);
      break;
    case 'AssignmentPattern': patternNames(node.left, out); break;
    case 'RestElement': patternNames(node.argument, out); break;
    default: break;
  }
  return out;
}

