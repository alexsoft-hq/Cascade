// Pure views over persisted structure. Module names are directories, never business claims.
const cmp = (a, b) => String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
const DEPENDENCIES = new Set(['imports', 'exports', 'CALLS', 'MAY_CALL', 'references-call']);
export function directoryOf(file, depth) {
  const parts = file.replaceAll('\\', '/').split('/'); parts.pop();
  return parts.slice(0, depth).join('/') || '.';
}
function identities(s) {
  const map = new Map();
  const put = (id, file) => { if (!map.has(id)) map.set(id, new Set()); map.get(id).add(file); };
  for (const f of s.files) put(`file:${f.path}`, f.path);
  for (const d of s.declarations) for (const id of [d.id, ...(d.impactIds ?? [])]) put(id, d.file);
  return map;
}
function oneFile(map, id) {
  const files = map.get(id);
  return files?.size === 1 ? [...files][0] : null;
}
function unresolvedRow(r, fromFile, graph, depth, ambiguous) {
  return { from: r.from, module: fromFile ? directoryOf(fromFile, depth) : null,
    type: r.type, target: r.to ?? r.source ?? r.name ?? null, sourceFile: fromFile,
    resolution: r.resolution ?? null,
    reason: ambiguous ? 'ambiguous-file-identity' : 'target-not-resolved-to-an-analyzed-file',
    external: graph?.nodes?.get(r.to)?.external === true };
}
function addDependency(edges, r, fromFile, toFile, from, to) {
  const key = JSON.stringify([from, to, r.type]);
  if (!edges.has(key)) edges.set(key, { from, to, type: r.type, count: 0, grades: {},
    examplesTotal: 0, examplesOmitted: 0, provenance: r.type === 'CALLS' || r.type === 'MAY_CALL' ? 'recorded-call' : r.type === 'references-call' ? 'structural-call-reference' : 'written-import', examples: [] });
  const edge = edges.get(key); edge.count++; edge.examplesTotal++;
  if (r.grade) edge.grades[r.grade] = (edge.grades[r.grade] ?? 0) + 1;
  const example = { fromFile, toFile, from: r.from, to: r.to,
    evidence: r.evidence ?? null, line: r.line ?? r.evidence?.line ?? null, grade: r.grade ?? null, resolution: r.resolution ?? null };
  if (edge.examples.length < 3) edge.examples.push(example);
  edge.examplesOmitted = edge.examplesTotal - edge.examples.length;
}
function moduleRows(s, depth) {
  const groups = new Map();
  for (const f of s.files) {
    const key = directoryOf(f.path, depth);
    if (!groups.has(key)) groups.set(key, { module: key, basis: 'inferred-directory', files: 0, declarations: 0, dependenciesOut: 0, dependenciesIn: 0, externalFiles: 0 });
    const row = groups.get(key); row.files++;
    if (f.external) row.externalFiles++;
  }
  for (const d of s.declarations) { const row = groups.get(directoryOf(d.file, depth)); if (row) row.declarations++; }
  return groups;
}
export function structureView(s, graph, depth) {
  const groups = moduleRows(s, depth), ids = identities(s), edges = new Map(), unresolved = [];
  const relations = s.relations.slice().sort((a, b) => cmp(JSON.stringify(a), JSON.stringify(b)));
  for (const r of relations) {
    if (r.type === 'contains' || (r.type === 'exports' && !r.source && !r.to)) continue;
    const a = oneFile(ids, r.from), b = oneFile(ids, r.to);
    if (!a || !b) {
      unresolved.push(unresolvedRow(r, a, graph, depth, ids.get(r.from)?.size > 1 || ids.get(r.to)?.size > 1));
      continue;
    }
    if (!DEPENDENCIES.has(r.type)) continue;
    const from = directoryOf(a, depth), to = directoryOf(b, depth);
    if (from === to) continue;
    addDependency(edges, r, a, b, from, to);
    groups.get(from).dependenciesOut++; groups.get(to).dependenciesIn++;
  }
  return { items: [...groups.values()].sort((a, b) => cmp(a.module, b.module)),
    dependencies: [...edges.values()].sort((a, b) => cmp(JSON.stringify([a.from, a.to, a.type]), JSON.stringify([b.from, b.to, b.type]))), unresolved };
}
export function recordedEntrypoints(graph) {
  const nodes = graph?.nodes instanceof Map ? [...graph.nodes.values()] : [];
  const links = (graph?.edges ?? []).filter((e) => e.type === 'HANDLES');
  const served = new Set(links.map((e) => e.from));
  return nodes.filter((n) => n.kind === 'screen' || (n.kind === 'endpoint' && (n.handler || served.has(n.id)))).map((n) => ({
    id: n.id, kind: n.kind, method: n.httpMethod ?? null, path: n.path ?? n.id.slice(n.id.indexOf(':') + 1),
    file: n.file ?? n.component ?? null, line: n.line ?? null, handler: n.handler ?? null,
    source: n.source ?? null, observed: n.observed === true, linkGrades: [...new Set(links.filter((e) => e.from === n.id).map((e) => e.grade).filter(Boolean))].sort(),
    evidence: n.kind === 'endpoint' ? 'recorded-endpoint' : 'recorded-screen',
  })).sort((a, b) => cmp(a.id, b.id));
}
const size = (value) => Buffer.byteLength(JSON.stringify(value));
function describeLists(answer, rows, offset, blocked = new Set()) {
  const empty = {};
  for (const key of Object.keys(rows)) {
    const shown = answer[key].length, total = rows[key].length;
    answer.totals[key] = total;
    answer.omitted[key] = total - shown;
    answer.paging[key] = { offset, nextOffset: shown && offset + shown < total ? offset + shown : null };
    if (blocked.has(key)) Object.assign(answer.paging[key], { byteLimited: true, ...(!shown ? { blockedOffset: offset } : {}) });
    if (!shown) empty[key] = total ? 'not-in-this-axis' : 'none';
  }
  if (Object.keys(empty).length) answer.empty = empty; else delete answer.empty;
}
/** Bound the entire answer including disclosure, preserving stable offsets per list. */
export function boundedView(base, rows, { limit, offset, maxBytes }) {
  const answer = { ...base, budget: { maxBytes, unit: 'UTF-8 bytes of answer JSON, not tokens or envelope' }, totals: {}, omitted: {}, paging: {} };
  for (const key of Object.keys(rows)) answer[key] = [];
  describeLists(answer, rows, offset);
  if (size(answer) > maxBytes) return null;
  // Round-robin selection prevents module rows from starving dependencies and evidence.
  const blocked = new Set();
  for (let i = 0; i < limit; i++) for (const key of Object.keys(rows)) {
    if (blocked.has(key) || offset + i >= rows[key].length) continue;
    answer[key].push(rows[key][offset + i]); describeLists(answer, rows, offset, blocked);
    if (size(answer) > maxBytes) { answer[key].pop(); blocked.add(key); describeLists(answer, rows, offset, blocked); }
  }
  // byteLimited metadata itself costs bytes: remove last rows until disclosures fit.
  while (size(answer) > maxBytes) {
    const key = Object.keys(rows).reverse().find((k) => answer[k].length);
    if (!key) return null;
    answer[key].pop(); blocked.add(key); describeLists(answer, rows, offset, blocked);
  }
  return answer;
}
