// WHAT THIS MODULE OWNS: parser-backed structural declarations and source spans.
// WHAT IT MUST NEVER KNOW ABOUT: impact graphs, frameworks or filesystem state.
import { structuralReferences } from './structural_refs.mjs';
// Structural declarations only. Babel offsets count UTF-16 code units and end
// exclusively. Wrapped/transformed scripts without a source map omit offsets.
function descriptor(node, parent) {
  const type = node.type;
  if (/^(ClassDeclaration|ClassExpression|TSInterfaceDeclaration|TSTypeAliasDeclaration|TSEnumDeclaration)$/.test(type)) {
    return { kind: type.startsWith('Class') ? 'class' : type === 'TSInterfaceDeclaration' ? 'interface' : type === 'TSEnumDeclaration' ? 'enum' : 'type', name: node.id?.name ?? parent?.id?.name };
  }
  if (!/^(FunctionDeclaration|FunctionExpression|ArrowFunctionExpression|ClassMethod|ClassPrivateMethod|ObjectMethod|TSDeclareFunction|TSDeclareMethod|TSMethodSignature|TSConstructSignatureDeclaration|TSCallSignatureDeclaration)$/.test(type)) return null;
  const name = node.id?.name ?? node.key?.name ?? node.key?.value ?? parent?.id?.name ?? parent?.key?.name ?? (parent?.type === 'ExportDefaultDeclaration' ? 'default' : type === 'TSConstructSignatureDeclaration' ? 'constructor' : type === 'TSCallSignatureDeclaration' ? '(call)' : null);
  return { kind: node.kind === 'constructor' || type === 'TSConstructSignatureDeclaration' ? 'constructor' : type.startsWith('Class') || type === 'TSDeclareMethod' || type === 'TSMethodSignature' ? 'method' : 'function', name };
}

function recordOf(node, desc, owner, options) {
  const { code, file, lineOffset = 0, startOffset = null, columnOffset = 0 } = options;
  const mapped = Number.isInteger(startOffset);
  const bodyStart = node.body?.start;
  const signatureEnd = Number.isInteger(bodyStart) ? bodyStart : node.end;
  return { kind: 'declaration', declarationKind: desc.kind, file, name: String(desc.name),
    qualifiedName: owner ? `${owner}.${desc.name}` : String(desc.name), owner,
    line: node.loc.start.line + lineOffset, endLine: node.loc.end.line + lineOffset,
    startColumn: node.loc.start.column + 1 + (node.loc.start.line === 1 ? columnOffset : 0),
    endColumn: node.loc.end.column + 1 + (node.loc.end.line === 1 ? columnOffset : 0),
    startOffset: mapped ? startOffset + node.start : null, endOffset: mapped ? startOffset + node.end : null,
    offsetEncoding: mapped ? 'utf16' : null,
    signature: code.slice(node.start, signatureEnd).trim(), signatureKind: 'source',
    params: (node.params ?? node.parameters ?? []).map((p) => code.slice(p.start, p.end)),
  };
}

export function structuralDeclarations(ast, options) {
  const records = [], nodes = new Map();
  function visit(node, parent, owner) {
    if (!node || typeof node.type !== 'string') return;
    const desc = descriptor(node, parent);
    let nestedOwner = owner;
    if (desc?.name && node.loc) {
      const record = recordOf(node, desc, owner, options);
      records.push(record); nodes.set(node, record);
      nestedOwner = record.qualifiedName;
    }
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'tokens', 'comments', 'errors'].includes(key)) continue;
      if (Array.isArray(value)) { for (const child of value) visit(child, node, nestedOwner); }
      else if (value && typeof value === 'object') visit(value, node, nestedOwner);
    }
  }
  visit(ast, null, null);
  return [...records, ...structuralReferences(ast, options, nodes)];
}
