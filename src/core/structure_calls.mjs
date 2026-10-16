import path from 'node:path';

// Written calls supplement structure only. They carry no causal impact grade.
// The parser's lexical binding, rather than a matching name, is the evidence.
const unique = (xs = []) => xs.length === 1 ? xs[0] : null;
const key = (...parts) => parts.join('\0');
function append(map, id, value) {
  if (!map.has(id)) map.set(id, []);
  map.get(id).push(value);
}

function callIndexes(declarations, records, lane) {
  const symbols = new Map(), offsets = new Map();
  for (const d of declarations) if (d.lane === lane) {
    append(symbols, key(d.file, d.qualifiedName), d);
    if (Number.isInteger(d.startOffset)) append(offsets, key(d.file, d.startOffset), d);
  }
  return { symbols, exports: exportIndex(records), offsets };
}

function hasExportMetadata(r) {
  return r.kind === 'structural-reference-scope' || (r.kind === 'declaration' && r.exportNames);
}

function exportIndex(records) {
  const exports = new Map();
  const richFiles = new Set(records.filter(hasExportMetadata).map((r) => r.file));
  for (const r of records) if (!richFiles.has(r.file) && r.kind === 'function' && ['named', 'default'].includes(r.exported)) {
    append(exports, key(r.file, r.exported === 'default' ? 'default' : r.name), r);
  }
  for (const r of records) if (r.kind === 'declaration') {
    for (const name of r.exportNames ?? []) append(exports, key(r.file, name), { startOffset: r.startOffset });
  }
  return exports;
}

function targetDeclaration(indexes, file, imported) {
  const fn = unique(indexes.exports.get(key(file, imported)));
  if (!fn) return null;
  if (Number.isInteger(fn.startOffset)) return unique(indexes.offsets.get(key(file, fn.startOffset)));
  return unique((indexes.symbols.get(key(file, fn.name)) ?? []).filter((d) => d.line === fn.line));
}

function targetFileOf(files, file, source) {
  if (typeof source !== 'string' || !source.startsWith('.')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), source));
  if (path.posix.extname(base) && files.has(base)) return base;
  const stem = base.replace(/\.js$/, '');
  return unique([...new Set([base, `${stem}.ts`, `${stem}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.mjs`, `${base}/index.ts`, `${base}/index.js`])].filter((p) => files.has(p)));
}

export function writtenWebCalls(ctx, records, lane = 'web') {
  const indexes = callIndexes(ctx.declarations, records, lane);
  const relations = parsedReferences(ctx, records, indexes);
  const parsedFiles = new Set(records.filter((r) => r.kind === 'structural-reference-scope').map((r) => r.file));
  for (const r of records) {
    if (!legacyImportCall(r, parsedFiles)) continue;
    const targetFile = targetFileOf(ctx.files, r.file, r.binding.source);
    if (!targetFile) continue;
    const from = unique((indexes.symbols.get(key(r.file, r.enclosing)) ?? []).filter((d) => d.line <= r.line && d.endLine >= r.line));
    const to = targetDeclaration(indexes, targetFile, r.binding.imported);
    if (!from || !to) continue;
    relations.push(legacyRelation(r, from, to));
  }
  return relations;
}

function parsedReferences(ctx, records, indexes) {
  const relations = [];
  for (const r of records) {
    if (r.kind !== 'structural-reference') continue;
    const from = unique(indexes.offsets.get(key(r.file, r.sourceStartOffset)));
    const file = r.source ? targetFileOf(ctx.files, r.file, r.source) : null;
    const to = Number.isInteger(r.targetStartOffset)
      ? unique(indexes.offsets.get(key(r.file, r.targetStartOffset)))
      : file ? targetDeclaration(indexes, file, r.imported) : null;
    if (!from || !to) continue;
    relations.push(parsedRelation(r, from, to));
  }
  return relations;
}

function parsedRelation(r, from, to) {
  return { from: from.id, to: to.id, type: r.referenceKind === 'callback' ? 'references-callback' : 'references-call',
    line: r.line, resolution: r.resolution, provenance: 'parser-lexical-binding',
    evidence: { callee: r.callee, ...(r.alias ? { alias: r.alias } : {}),
      ...(r.source ? { source: r.source, imported: r.imported } : {}),
      ...(r.referenceKind === 'callback' ? { argumentIndex: r.argumentIndex } : {}) } };
}

function legacyImportCall(r, parsedFiles) {
  return !parsedFiles.has(r.file) && r.kind === 'call' && r.callee?.shape === 'ident' && r.binding?.kind === 'import';
}
function legacyRelation(r, from, to) {
  return { from: from.id, to: to.id, type: 'references-call', line: r.line,
    resolution: 'written-import-binding', provenance: 'parser-call-binding',
    evidence: { source: r.binding.source, imported: r.binding.imported, callee: r.callee.name } };
}
