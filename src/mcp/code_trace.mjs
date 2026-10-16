// Structure traversal preserves written references separately from graded impact edges.
import { ToolError } from './tools.mjs';
const TYPES = new Set(['CALLS', 'MAY_CALL', 'references-call', 'references-callback']);
const cmp = (a, b) => String(a).localeCompare(String(b), 'en');
const summary = (d) => d ? { id: d.id, name: d.qualifiedName || d.name, kind: d.kind, file: d.file, line: d.line } : null;
function identities(s) {
  const map = new Map();
  for (const d of s.declarations) for (const id of [d.id, ...(d.impactIds ?? [])]) {
    if (!map.has(id)) map.set(id, []);
    if (!map.get(id).includes(d)) map.get(id).push(d);
  }
  return map;
}
function resolve(s, ids, symbol) {
  const direct = ids.get(symbol);
  const found = direct ?? s.declarations.filter((d) => d.name === symbol || d.qualifiedName === symbol || `${d.file}#${d.qualifiedName}` === symbol);
  const unique = [...new Map(found.map((d) => [d.id, d])).values()];
  if (!unique.length) throw new ToolError('unknown-symbol', 'No declaration matches in analyzed structure; missing coverage does not prove absence.');
  if (unique.length !== 1) throw new ToolError('ambiguous-symbol', 'Multiple declarations match; use the exact declaration id from code_search or file_outline.');
  return unique[0];
}
function traceEdges(s, ids) {
  return s.relations.filter((r) => TYPES.has(r.type)).map((r) => {
    const from = ids.get(r.from), to = ids.get(r.to);
    return { relation: r, fromCandidates: from ?? [], toCandidates: to ?? [],
      from: from?.length === 1 ? from[0] : null, to: to?.length === 1 ? to[0] : null };
  }).sort((a, b) => cmp(JSON.stringify(a.relation), JSON.stringify(b.relation)));
}
function adjacent(edge, id, direction) {
  const source = direction === 'outbound' ? edge.fromCandidates : edge.toCandidates;
  if (!source.some((d) => d.id === id)) return null;
  const ambiguous = edge.fromCandidates.length > 1 || edge.toCandidates.length > 1;
  return { next: ambiguous ? null : direction === 'outbound' ? edge.to : edge.from, direction };
}
function endpointSummary(declaration, candidates, id) {
  return summary(declaration) ?? { id: id ?? null, unresolved: true,
    ...(candidates.length > 1 ? { candidateDeclarationIds: candidates.map((d) => d.id).sort(cmp) } : {}) };
}
function executionOf(r, ambiguous) {
  if (ambiguous) return 'ambiguous-impact-association-not-overload-proof';
  if (r.type === 'references-callback') return 'callback-reference-not-proven-execution';
  return r.grade ? 'graded-call-relation' : 'written-call-not-runtime-proof';
}
function traceRow(edge, hop, direction) {
  const r = edge.relation, ambiguous = edge.fromCandidates.length > 1 || edge.toCandidates.length > 1;
  return { hops: hop, direction, from: endpointSummary(edge.from, edge.fromCandidates, r.from),
    to: endpointSummary(edge.to, edge.toCandidates, r.to), type: r.type,
    grade: r.grade ?? null, provenance: r.provenance ?? (r.grade ? 'recorded-impact-call' : 'written-reference'),
    execution: executionOf(r, ambiguous), ...(ambiguous ? { ambiguousImpactAssociation: true } : {}),
    resolution: r.resolution ?? null, line: r.line ?? r.evidence?.line ?? null, evidence: r.evidence ?? null };
}
function adjacency(edges) {
  const map = new Map();
  edges.forEach((edge, index) => {
    for (const id of new Set([...edge.fromCandidates, ...edge.toCandidates].map((d) => d.id))) {
      if (!map.has(id)) map.set(id, []);
      map.get(id).push(index);
    }
  });
  return map;
}
function walk(edges, entry, direction, depth) {
  const queue = [{ id: entry.id, hop: 0 }], seen = new Set([entry.id]), used = new Set(), items = [];
  let depthLimited = false;
  const neighbors = adjacency(edges);
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i];
    for (const j of neighbors.get(current.id) ?? []) {
      const step = adjacent(edges[j], current.id, direction);
      if (!step || used.has(j)) continue;
      if (current.hop >= depth) { depthLimited = true; continue; }
      used.add(j); items.push({ identity: JSON.stringify(edges[j].relation), row: traceRow(edges[j], current.hop + 1, step.direction) });
      if (step.next && !seen.has(step.next.id)) { seen.add(step.next.id); queue.push({ id: step.next.id, hop: current.hop + 1 }); }
    }
  }
  return { items, depthLimited, visited: seen };
}
export function traceStructure(s, { symbol, direction, depth }) {
  const ids = identities(s), entry = resolve(s, ids, symbol);
  const edges = traceEdges(s, ids);
  const directions = direction === 'both' ? ['inbound', 'outbound'] : [direction];
  const result = mergeWalks(directions.map((d) => walk(edges, entry, d, depth)));
  return { entry: summary(entry), direction, depth, ...result,
    coverage: s.coverage, unknown: 'Unrecorded, unresolved, dynamic and excluded calls remain unknown; callback references do not prove execution. Paths through references are structural reachability, not causal impact.',
    contentTrust: 'untrusted-source-metadata' };
}

function mergeWalks(walks) {
  const rows = new Map(), visited = new Set(), ambiguous = new Set();
  for (const w of walks) {
    for (const id of w.visited) visited.add(id);
    for (const item of w.items) {
      const key = `${item.row.direction}\0${item.identity}`, previous = rows.get(key);
      if (!previous || item.row.hops < previous.row.hops) rows.set(key, item);
      if (item.row.ambiguousImpactAssociation) ambiguous.add(item.identity);
    }
  }
  const sorted = [...rows.entries()].sort(([a, x], [b, y]) => x.row.hops - y.row.hops || cmp(a, b));
  return { items: sorted.map(([, item]) => item.row), depthLimited: walks.some((w) => w.depthLimited),
    visitedDeclarations: visited.size, ambiguousImpactRelations: ambiguous.size };
}
