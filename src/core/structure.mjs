// A bounded, persistent view of declarations already read by Cascade's lanes.
// This projection does not add nodes or relationships to the impact graph.
import path from 'node:path';
import { writtenWebCalls } from './structure_calls.mjs';
import { digest12 } from './canonical.mjs';
import { javaShardKey, webShardKey, tsShardKey } from './facts_store.mjs';
import { TS_WORKER_VERSION } from './worker_versions.mjs';

export const STRUCTURE_SCHEMA = 'cascade:structure:1';
export const STRUCTURE_FILE = 'structure.json';
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const positive = (n) => Number.isInteger(n) && n > 0 ? n : null;
const externalPath = (p) => path.posix.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p) || p.split('/').includes('..');
const fileId = (p) => `file:${p}`;

/** The index hashes facts.jsonl, NOT source bytes. Accept a source hash only
 * when it reproduces the recorded source-dependent shard key. The caller may
 * read current bytes; mismatches are deliberately unavailable to snippet tools.
 * This establishes cache-key agreement, not an atomic source snapshot. */
export function matchingSourceHashes(factsIndex, hashFile) {
  const out = {};
  const groups = [Object.entries(factsIndex?.files ?? {}), Object.entries(factsIndex?.tsFiles ?? {})];
  for (const entries of groups) for (const [file, e] of entries) {
    const lane = e.lane ?? 'java';
    const keyOf = { java: javaShardKey, web: webShardKey, ts: tsShardKey }[lane];
    const version = lane === 'ts' ? TS_WORKER_VERSION : factsIndex?.workers?.[lane];
    try {
      const sha256 = hashFile(file);
      if (!keyOf || !version || !/^[a-f0-9]{64}$/.test(sha256)) continue;
      if (keyOf({ path: file, contentSha256: sha256, workerVersion: version }) !== e.shardKey) continue;
      if (out[file] && out[file] !== sha256) { out[file] = null; continue; }
      out[file] = sha256;
    } catch { /* unreadable source is reported as unknown by the projection */ }
  }
  return out;
}

function touchFile(files, file, lane) {
  if (typeof file !== 'string' || !file || file.includes('\0')) return null;
  if (!files.has(file)) files.set(file, { path: file, lanes: [], status: 'read', sha256: null, hashStatus: 'unknown', external: externalPath(file) });
  const f = files.get(file);
  if (!f.lanes.includes(lane)) f.lanes.push(lane);
  return f;
}

function hasExactOffsets(r) {
  return r.offsetEncoding === 'utf16' && Number.isInteger(r.startOffset) && r.startOffset >= 0 && Number.isInteger(r.endOffset) && r.endOffset >= r.startOffset;
}

function addDeclaration(ctx, lane, r, kind, name, qualifiedName, extra = {}) {
  const { files, ordinals, nodeIds, declarations, relations } = ctx;
  if (!touchFile(files, r.file, lane) || typeof name !== 'string' || !name) return null;
  const line = positive(r.line);
  const endLine = positive(r.endLine) >= line && line !== null ? positive(r.endLine) : null;
  const identity = { lane, file: r.file, kind, qualifiedName, line, startOffset: r.startOffset ?? null, signature: r.signature ?? null, arity: extra.arity ?? null };
  const key = digest12(identity);
  const ordinal = ordinals.get(key) ?? 0;
  ordinals.set(key, ordinal + 1);
  const id = `declaration:${key}:${ordinal}`;
  const candidates = lane === 'java'
    ? [`symbol:${qualifiedName}`]
    : [`symbol:${r.file}#${qualifiedName}`];
  const d = { id, kind, name, qualifiedName, owner: extra.owner ?? null, file: r.file,
    line, endLine, extent: hasExactOffsets(r) ? 'exact' : line !== null ? 'start-only' : 'unknown',
    startOffset: r.startOffset ?? null, endOffset: r.endOffset ?? null, offsetEncoding: r.offsetEncoding ?? null,
    startColumn: r.startColumn ?? null, endColumn: r.endColumn ?? null,
    signature: r.signature ?? null, signatureKind: r.signatureKind ?? null,
    params: extra.params ?? null, arity: extra.arity ?? null, lane,
    impactIds: candidates.filter((n) => nodeIds.has(n)) };
  declarations.push(d);
  relations.push({ from: fileId(r.file), to: id, type: 'contains' });
  return d;
}

function addJavaType(ctx, r) {
  const lane = 'java';
  addDeclaration(ctx, lane, r, r.typeKind?.toLowerCase() ?? 'type', r.fqn?.split('.').at(-1), r.fqn);
  (r.declaredMethods ?? []).forEach((method, i) => {
    const slash = method.lastIndexOf('/');
    const name = slash < 0 ? method : method.slice(0, slash);
    const arity = slash < 0 ? null : Number(method.slice(slash + 1));
    addDeclaration(ctx, lane, { file: r.file, line: r.declaredMethodLines?.[i] }, 'method', name, `${r.fqn}#${name}`, { owner: r.fqn, arity: Number.isInteger(arity) ? arity : null });
  });
}

function addScriptDeclaration(ctx, lane, r) {
  const member = lane === 'web' && r.kind === 'function' ? ctx.webMembers.get(`${r.file}\0${r.name}`) : null;
  const owner = r.class ?? member?.owner ?? null;
  const name = member?.name ?? r.name;
  const qualifiedName = member ? r.name : owner ? `${owner}.${name}` : name;
  addDeclaration(ctx, lane, r, member ? 'method' : r.kind, name, qualifiedName,
    { owner, params: Array.isArray(r.params) ? r.params.map((p) => typeof p === 'string' ? p : p?.name ?? null) : null,
      arity: Array.isArray(r.params) ? r.params.length : Number.isInteger(r.params) ? r.params : null });
}

/** Dotted function names alone also describe object literals. Only an explicit
 * same-file class census can establish a class member; ambiguous owners remain unknown. */
function webMethodOwners(records) {
  const members = new Map();
  for (const r of records) if (r?.kind === 'class' && typeof r.name === 'string') {
    for (const name of r.methods ?? []) {
      const key = `${r.file}\0${r.name}.${name}`;
      members.set(key, members.has(key) ? null : { owner: r.name, name });
    }
  }
  return members;
}

function readDeclarations(ctx, streams, javaFacts) {
  const { files, declarations, diagnostics } = ctx;
  for (const [lane, records] of streams) for (const r of records) {
    const f = touchFile(files, r?.file, lane);
    if (!f) continue;
    recordReadStatus(f, r, lane, diagnostics);
    if (r.kind === 'declaration') {
      addDeclaration(ctx, lane, r, r.declarationKind, r.name, r.qualifiedName, { owner: r.owner, params: r.params, arity: r.params?.length ?? null });
      continue;
    }
    if (ctx.richFiles.has(`${lane}\0${r.file}`)) continue;
    if (lane === 'java' && r.kind === 'type') addJavaType(ctx, r);
    else if (lane !== 'java' && ['class', 'interface', 'function', 'method'].includes(r.kind)) addScriptDeclaration(ctx, lane, r);
  }
  // Java special type records may not include a full declaration census.
  for (const r of javaFacts) if (r?.kind === 'method' && !ctx.richFiles.has(`java\0${r.file}`) && !declarations.some((d) => d.lane === 'java' && d.file === r.file && d.qualifiedName === r.fqn && d.line === positive(r.line))) {
    addDeclaration(ctx, 'java', r, 'method', r.name, r.fqn, { owner: r.owner, arity: r.paramCount ?? null });
  }
}

function recordReadStatus(f, r, lane, diagnostics) {
  if (r.kind === 'file' && r.skipped) {
    f.status = 'skipped';
    diagnostics.push({ kind: 'FILE_SKIPPED', file: r.file, lane, reason: String(r.skipped) });
  } else if (r.kind === 'parse_error') {
    if (!r.recovered || f.status === 'read') f.status = r.recovered ? 'partial' : 'parse-error';
    diagnostics.push({ kind: 'PARSE_ERROR', file: r.file, lane, recovered: !!r.recovered });
  } else if (r.kind === 'file' && r.recoveredErrors > 0 && f.status === 'read') f.status = 'partial';
}

function resolveRelative(files, file, source) {
  if (!source.startsWith('.')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), source));
  const stem = base.replace(/\.js$/, '');
  return [base, `${stem}.ts`, `${stem}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.mjs`, `${base}/index.ts`, `${base}/index.js`].find((p) => files.has(p)) ?? null;
}

function readRelations(ctx, streams) {
  const { files, declarations, relations } = ctx;
  const declarationAt = (lane, file, name) => declarations.find((d) => d.lane === lane && d.file === file && d.qualifiedName === name);
  for (const d of declarations) if (d.owner) {
    const owner = declarationAt(d.lane, d.file, d.owner);
    if (owner) relations.push({ from: owner.id, to: d.id, type: 'contains' });
  }
  for (const [lane, records] of streams) for (const r of records) {
    if (!files.has(r?.file)) continue;
    if (r.kind === 'import' || r.kind === 'export') {
      const source = r.source ?? (lane === 'java' ? r.fqn : null);
      const target = source && lane !== 'java' ? resolveRelative(files, r.file, source) : null;
      relations.push({ from: fileId(r.file), to: target ? fileId(target) : null,
        type: r.kind === 'import' ? 'imports' : 'exports', source, name: r.name ?? null,
        line: positive(r.line), resolution: target ? 'relative-file' : 'written-only' });
    }
    if (['type', 'class', 'interface'].includes(r.kind)) {
      const from = declarationAt(lane, r.file, r.fqn ?? r.name);
      if (!from) continue;
      for (const [field, type] of [['extends', 'extends'], ['implements', 'implements']]) {
        for (const name of Array.isArray(r[field]) ? r[field] : typeof r[field] === 'string' ? [r[field]] : []) {
          relations.push({ from: from.id, to: null, type, name, resolution: 'written-only' });
        }
      }
    }
  }
}

function finishFilesAndCalls(ctx, graph, sourceHashes) {
  const { files, relations, diagnostics } = ctx;
  // Preserve impact semantics verbatim. Endpoints here are existing impact IDs,
  // joined through declaration.impactIds; do not imply overload-level precision.
  for (const e of graph?.edges ?? []) if (['CALLS', 'MAY_CALL'].includes(e.type)) {
    relations.push({ from: e.from, to: e.to, type: e.type, grade: e.grade, ...(e.evidence ? { evidence: e.evidence } : {}) });
  }
  for (const f of files.values()) {
    f.lanes.sort();
    const hash = sourceHashes[f.path];
    if (typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash)) { f.sha256 = hash; f.hashStatus = 'matches-shard-key'; }
    else diagnostics.push({ kind: 'SOURCE_HASH_UNKNOWN', file: f.path });
  }
}

function serializeStructure(ctx, { factsIndex, sourceHashes, project, packDigest }) {
  const { files, declarations, relations, diagnostics } = ctx;
  const sortObjects = (xs) => xs.sort((a, b) => cmp(JSON.stringify(a), JSON.stringify(b)));
  const inputDigest = digest12({ files: factsIndex.files ?? {}, tsFiles: factsIndex.tsFiles ?? {}, workers: factsIndex.workers ?? {}, selection: factsIndex.selection ?? {}, sourceHashes });
  const doc = { schema: STRUCTURE_SCHEMA, project, packDigest, inputDigest,
    files: [...files.values()].sort((a, b) => cmp(a.path, b.path)),
    declarations: declarations.sort((a, b) => cmp(a.file, b.file) || (a.line ?? 0) - (b.line ?? 0) || cmp(a.id, b.id)),
    relations: sortObjects(relations), diagnostics: sortObjects(diagnostics),
    coverage: { scope: 'analyzed-inputs', lanes: [...new Set([...files.values()].flatMap((f) => f.lanes))].sort(), complete: false,
      limitations: ['Only files selected by existing lanes are represented.', 'Signatures and declaration extents may be unavailable.', 'Legacy cached Java census records may merge same-arity overloads and omit constructors; parser declaration records distinguish them.', 'Import aliases and inheritance targets remain written-only unless resolved explicitly.', 'Source hashes match cache keys; extraction is not an atomic filesystem snapshot.'] } };
  return { ...doc, digest: digest12(doc) };
}

/** Project the facts selected by existing lanes, without changing impact semantics. */
export function buildStructure({ javaFacts = [], tsFacts = [], webFacts = [], graph = null,
  factsIndex = {}, sourceHashes = {}, project = null, packDigest = null } = {}) {
  const nodes = graph?.nodes instanceof Map ? [...graph.nodes.values()] : [];
  const ctx = { files: new Map(), declarations: [], relations: [], diagnostics: [], ordinals: new Map(), nodeIds: new Set(nodes.map((n) => n.id)), webMembers: webMethodOwners(webFacts) };
  for (const [file, e] of Object.entries(factsIndex.files ?? {})) touchFile(ctx.files, file, e.lane ?? 'java');
  for (const file of Object.keys(factsIndex.tsFiles ?? {})) touchFile(ctx.files, file, 'ts');
  const streams = [['java', javaFacts], ['ts', tsFacts], ['web', webFacts]];
  ctx.richFiles = new Set(streams.flatMap(([lane, rs]) => rs.filter((r) => r.kind === 'declaration').map((r) => `${lane}\0${r.file}`)));
  readDeclarations(ctx, streams, javaFacts);
  readRelations(ctx, streams);
  ctx.relations.push(...writtenWebCalls(ctx, webFacts), ...writtenWebCalls(ctx, tsFacts, 'ts'));
  finishFilesAndCalls(ctx, graph, sourceHashes);
  return serializeStructure(ctx, { factsIndex, sourceHashes, project, packDigest });
}

export function structureMetadata(s) {
  return { schema: s.schema, digest: s.digest, inputDigest: s.inputDigest,
    files: s.files.length, declarations: s.declarations.length, relations: s.relations.length };
}

/** Reject a mismatched sidecar even when an impact-only digest did not change. */
export function validateStructure(s, { pack } = {}) {
  if (!s || s.schema !== STRUCTURE_SCHEMA) throw new Error('unknown structure schema');
  for (const k of ['files', 'declarations', 'relations', 'diagnostics']) if (!Array.isArray(s[k])) throw new Error(`structure.${k} must be an array`);
  const { digest, ...body } = s;
  if (digest12(body) !== digest) throw new Error('structure digest mismatch');
  if (pack && (pack.meta?.structure?.digest !== digest || pack.meta?.structure?.inputDigest !== s.inputDigest || pack.digest !== s.packDigest)) throw new Error('structure belongs to a different pack generation');
  return s;
}
