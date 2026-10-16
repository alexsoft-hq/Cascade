// WHAT THIS MODULE OWNS: lexical written-call and callback-reference facts.
// WHAT IT MUST NEVER KNOW ABOUT: impact grades, frameworks, or other files.
import { readScopes } from '../../ts/tsscope.mjs';
import { eachChild, isFunctionNode } from './ast.mjs';

function definitionsOf(ast, scopes, declarations) {
  const definitions = new Map(), imports = new Map(), writes = new Set();
  let unsafe = false;
  function visit(node) {
    if (node.type === 'WithStatement' || (node.type === 'Identifier' && ['eval', 'Function'].includes(node.name))) unsafe = true;
    if (node.type === 'ImportDeclaration' && node.importKind !== 'type') {
      for (const spec of node.specifiers) if (spec.importKind !== 'type' && spec.type !== 'ImportNamespaceSpecifier') {
        imports.set(spec.local.name, { source: node.source.value, imported: spec.imported?.name ?? spec.imported?.value ?? 'default' });
      }
    }
    if (['AssignmentExpression', 'UpdateExpression', 'ForInStatement', 'ForOfStatement'].includes(node.type)) {
      const note = (n) => { if (n.type === 'Identifier') writes.add(n.name); else eachChild(n, note); };
      note(node.left ?? node.argument);
    }
    if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') {
      if (node.id) definitions.set(scopes.identity(node.id), { declaration: declarations.get(node) });
    }
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') {
      definitions.set(scopes.identity(node.id), { declaration: declarations.get(node.init), alias: node.init?.type === 'Identifier' ? node.init : null });
    }
    eachChild(node, visit);
  }
  visit(ast);
  definitions.delete(null);
  for (const name of writes) imports.delete(name);
  return { definitions, imports, unsafe };
}

function resolveIdentifier(id, state, seen = new Set()) {
  const binding = state.scopes.identity(id);
  if (!binding) return state.imports.get(id.name) ?? null;
  if (binding.reassigned || seen.has(binding) || !['const', 'function'].includes(binding.kind)) return null;
  seen.add(binding);
  const def = state.definitions.get(binding);
  if (def?.declaration) return { declaration: def.declaration };
  if (!def?.alias) return null;
  const target = resolveIdentifier(def.alias, state, seen);
  return target ? { ...target, alias: id.name } : null;
}

function defaultExportTarget(node, state, declarations) {
  if (node.type === 'Identifier') return resolveIdentifier(node, state)?.declaration;
  return node.id ? resolveIdentifier(node.id, state)?.declaration : declarations.get(node);
}

function markExports(program, state, declarations) {
  const mark = (record, name) => { if (record) record.exportNames = [...new Set([...(record.exportNames ?? []), name])]; };
  for (const statement of program.body) {
    if (statement.exportKind === 'type') continue;
    if (statement.type === 'ExportDefaultDeclaration') {
      const d = statement.declaration;
      mark(defaultExportTarget(d, state, declarations), 'default');
    }
    if (statement.type !== 'ExportNamedDeclaration' || statement.source) continue;
    const d = statement.declaration;
    if (d?.id?.name) mark(resolveIdentifier(d.id, state)?.declaration, d.id.name);
    for (const v of d?.declarations ?? []) if (v.id.type === 'Identifier') mark(resolveIdentifier(v.id, state)?.declaration, v.id.name);
    for (const s of statement.specifiers ?? []) {
      if (s.exportKind === 'type') continue;
      const target = resolveIdentifier(s.local, state);
      mark(target?.declaration, s.exported.name ?? s.exported.value);
    }
  }
}

function referenceOf(node, id, owner, state, options, argumentIndex) {
  const target = resolveIdentifier(id, state);
  if (!target || !owner || owner.startOffset === null) return null;
  const declaration = target.declaration;
  if (declaration && declaration.startOffset === null) return null;
  return { kind: 'structural-reference', file: options.file,
    referenceKind: argumentIndex === null ? 'call' : 'callback',
    sourceStartOffset: owner.startOffset, targetStartOffset: declaration?.startOffset ?? null,
    source: target.source ?? null, imported: target.imported ?? null, alias: target.alias ?? null,
    line: node.loc.start.line + (options.lineOffset ?? 0), callee: id.name, argumentIndex,
    resolution: target.alias ? 'immutable-alias-binding' : declaration ? 'lexical-function-binding' : 'written-import-binding' };
}

export function structuralReferences(ast, options, declarations) {
  if (!declarations.size) return [];
  const scopes = options.scopes ?? readScopes(ast);
  const state = { scopes, ...definitionsOf(ast, scopes, declarations) }, records = [];
  const scopeRecord = { kind: 'structural-reference-scope', file: options.file, line: 1 + (options.lineOffset ?? 0),
    coverage: 'direct-identifiers-and-argument-references', dynamicScope: state.unsafe };
  if (state.unsafe) return [scopeRecord];
  markExports(ast.program, state, declarations);
  function visit(node, owner) {
    const current = isFunctionNode(node) ? declarations.get(node) ?? null : owner;
    if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') {
      const add = (id, index) => { if (id?.type === 'Identifier') { const r = referenceOf(node, id, current, state, options, index); if (r) records.push(r); } };
      add(node.callee, null);
      node.arguments.forEach((arg, index) => add(arg, index));
    }
    eachChild(node, (child) => visit(child, current));
  }
  visit(ast, null);
  return [scopeRecord, ...records];
}
