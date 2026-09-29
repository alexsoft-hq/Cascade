// openapi_bridge.mjs — routes a project DECLARES, read from the document it publishes.
//
// Every other lane in this engine reads code. This one reads a contract: an
// OpenAPI 3 or Swagger 2 document, in JSON or in a subset of YAML, and turns
// each (method, path) it declares into an endpoint node with the SAME id the
// Java lane would give it — `endpoint:<METHOD> <path>` — so the two meet on the
// node instead of beside it.
//
// WHY IT EARNS ITS PLACE, in two sentences:
//
//  1. GENERALITY. A backend this engine has no source lane for (Node, Go,
//     Python, .NET) still publishes a document, and with it the frontend's calls
//     have something to land on. Without it, a repository whose backend is not
//     Java gets a web lane whose every call is UNRESOLVED and an answer that
//     says nothing.
//  2. DRIFT. Where a Java lane DOES run, the document and the code are two
//     independent statements about the same routes, and they disagree in real
//     projects: a route the document declares and nothing serves, a route the
//     code serves and no document mentions. That census is on `laneStats.openapi`
//     and it is a readout no single-source tool can produce.
//
// WHAT A DOCUMENT DOES NOT BUY. It is a DECLARATION: it says a route exists, not
// what runs below it. So a document route gets NO handler edge and nothing under
// it, and `declareAxes` degrades the `code` axis when the routes came only from
// documents — a frontend call reaches an endpoint and stops there. The one
// exception is a controller that implements an interface the build generates
// from the document: a contract rule may pair the two by the generator's naming,
// and that link is a HEURISTIC one (src/adapters/contract_links.mjs).
//
// EXACT, by declaration: the project wrote this file to say what it serves, so
// the fact "this route is declared" is read, not inferred. It never upgrades a
// grade on anything else: a route the code also serves keeps whatever the code
// lane gave it, and the document is recorded beside it in `declaredBy`.

import { nodeId } from '../core/graph.mjs';
import { addContractLinks } from './contract_links.mjs';

/** The verbs a path item can carry. Anything else under a path is not an operation. */
export const HTTP_VERBS = Object.freeze(['get', 'put', 'post', 'delete', 'options', 'head', 'patch']);

/** The method an operation gets when the path item declares no verb at all. */
export const ANY_METHOD = 'ANY';

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** endpoint node id, keyed by "METHOD path" — the same key the Java bridge uses. */
export function openApiEndpointId(httpMethod, pathStr) {
  return nodeId('endpoint', `${httpMethod} ${pathStr}`);
}

/**
 * A route path, in the one spelling the whole engine uses: a leading slash, no
 * doubled slashes, no trailing slash. `{id}` templates are left exactly as
 * written, because that is the syntax the Java lane records too.
 */
function normalizePath(p) {
  let s = String(p ?? '').trim();
  if (s === '') return '/';
  if (!s.startsWith('/')) s = `/${s}`;
  s = s.replace(/\/{2,}/g, '/');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

// ---------------------------------------------------------------------------
// The YAML subset
// ---------------------------------------------------------------------------
//
// This engine has no runtime dependencies and no npm install step, so a YAML
// parser is either vendored or written. It is written, and it is deliberately
// SMALL: block mappings and sequences by indentation, plain and quoted scalars,
// `#` comments, flow sequences and flow mappings of scalars, and `|`/`>` block
// scalars kept as text.
//
// Everything else is REFUSED BY NAME rather than guessed at. An anchor, an
// alias, an explicit tag, a second document in the same file, a tab in the
// indentation: each of those comes back as an `unreadable` entry naming the line
// and the construct, and the caller reports the document as unreadable instead
// of shipping half of it. A YAML feature this reader silently mis-parsed would
// put routes in the graph that the file does not declare, which is worse than
// reading no routes at all.

/** One refusal: which line, which construct, and what the reader did about it. */
const refusal = (line, construct, detail) => ({
  line, construct,
  reason: `${construct} at line ${line}${detail ? ` (${detail})` : ''} is outside the YAML subset this reader accepts, so the document is not read. Convert it to JSON, or write the routes without it`,
});

/**
 * Read the YAML subset. Returns the parsed value, or null with the refusals.
 * @param {string} text
 * @returns {{value:(object|null), unreadable:{line:number, construct:string, reason:string}[]}}
 */
export function readYamlSubset(text) {
  const unreadable = [];
  const src = String(text ?? '').split('\n');
  const lines = [];
  let started = false;
  for (let i = 0; i < src.length; i += 1) {
    const raw = src[i].replace(/\r$/, '');
    const lineNo = i + 1;
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    if (trimmed === '---') {
      if (started) unreadable.push(refusal(lineNo, 'a second YAML document', 'this reader reads one document per file'));
      started = true;
      continue;
    }
    if (trimmed === '...') break;
    const indentMatch = /^[ \t]*/.exec(raw)[0];
    if (indentMatch.includes('\t')) {
      unreadable.push(refusal(lineNo, 'a tab in the indentation', 'YAML forbids tabs for indentation'));
      continue;
    }
    started = true;
    lines.push({ indent: indentMatch.length, text: trimmed, raw, lineNo });
  }
  if (unreadable.length > 0) return { value: null, unreadable };

  let value;
  try {
    const [parsed] = parseBlock(lines, 0, lines.length > 0 ? lines[0].indent : 0, unreadable);
    value = parsed;
  } catch (e) {
    unreadable.push({ line: e.line ?? 1, construct: e.construct ?? 'the document', reason: e.message });
    return { value: null, unreadable };
  }
  if (unreadable.length > 0) return { value: null, unreadable };
  return { value, unreadable };
}

class YamlRefusal extends Error {
  constructor(line, construct, detail) {
    const r = refusal(line, construct, detail);
    super(r.reason);
    this.name = 'YamlRefusal';
    this.line = line;
    this.construct = construct;
  }
}

/** Parse the run of lines at `indent` starting at `i`. Returns [value, nextIndex]. */
function parseBlock(lines, i, indent, unreadable) {
  if (i >= lines.length) return [null, i];
  if (lines[i].text.startsWith('- ') || lines[i].text === '-') return parseSequence(lines, i, indent, unreadable);
  return parseMapping(lines, i, indent, unreadable);
}

function parseSequence(lines, i, indent, unreadable) {
  const out = [];
  let k = i;
  while (k < lines.length && lines[k].indent === indent && (lines[k].text.startsWith('- ') || lines[k].text === '-')) {
    const line = lines[k];
    const rest = line.text === '-' ? '' : line.text.slice(2).trim();
    if (rest === '') {
      const [child, next] = childBlock(lines, k + 1, indent, unreadable);
      out.push(child);
      k = next;
      continue;
    }
    // `- key: value` opens a mapping whose first key sits on the dash's own line.
    const kv = splitKey(rest, line.lineNo);
    if (kv) {
      const inner = [{ indent: indent + 2, text: rest, raw: line.raw, lineNo: line.lineNo }];
      let j = k + 1;
      while (j < lines.length && lines[j].indent > indent) { inner.push(lines[j]); j += 1; }
      const [child] = parseMapping(inner, 0, indent + 2, unreadable);
      out.push(child);
      k = j;
      continue;
    }
    out.push(scalar(rest, line.lineNo));
    k += 1;
  }
  return [out, k];
}

function parseMapping(lines, i, indent, unreadable) {
  const out = {};
  let k = i;
  while (k < lines.length && lines[k].indent === indent) {
    const line = lines[k];
    if (line.text.startsWith('- ')) break;
    const kv = splitKey(line.text, line.lineNo);
    if (!kv) throw new YamlRefusal(line.lineNo, 'a line that is neither a mapping entry nor a sequence item', line.text.slice(0, 40));
    const { key, rest } = kv;
    if (rest === '') {
      const [child, next] = childBlock(lines, k + 1, indent, unreadable);
      out[key] = child;
      k = next;
      continue;
    }
    if (rest === '|' || rest === '>' || /^[|>][-+]?\d*$/.test(rest)) {
      const [textValue, next] = blockScalar(lines, k + 1, indent);
      out[key] = textValue;
      k = next;
      continue;
    }
    out[key] = scalar(rest, line.lineNo);
    k += 1;
  }
  return [out, k];
}

/** The block that belongs to a key or dash with nothing after it. */
function childBlock(lines, i, indent, unreadable) {
  if (i >= lines.length || lines[i].indent <= indent) return [null, i];
  return parseBlock(lines, i, lines[i].indent, unreadable);
}

/** A `|` / `>` block scalar: every deeper line, joined, kept as text. */
function blockScalar(lines, i, indent) {
  const parts = [];
  let k = i;
  while (k < lines.length && lines[k].indent > indent) { parts.push(lines[k].text); k += 1; }
  return [parts.join('\n'), k];
}

/**
 * Split `key: value`. A quoted key is read to its closing quote; a plain key
 * ends at the first `:` that is followed by a space or by the end of the line,
 * which is why `url: http://localhost:8080` reads as one key and one value.
 * @returns {{key:string, rest:string}|null}
 */
function splitKey(text, lineNo) {
  if (text.startsWith('"') || text.startsWith("'")) {
    const q = text[0];
    let end = -1;
    for (let i = 1; i < text.length; i += 1) {
      if (text[i] === '\\' && q === '"') { i += 1; continue; }
      if (text[i] === q) { end = i; break; }
    }
    if (end < 0) return null;
    const after = text.slice(end + 1).trimStart();
    if (!after.startsWith(':')) return null;
    return { key: unquote(text.slice(0, end + 1), lineNo), rest: stripComment(after.slice(1).trim()) };
  }
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== ':') continue;
    if (i + 1 < text.length && text[i + 1] !== ' ') continue;
    return { key: text.slice(0, i).trim(), rest: stripComment(text.slice(i + 1).trim()) };
  }
  return null;
}

/**
 * A trailing ` # comment` on a plain scalar. A quoted scalar keeps its hashes,
 * and a value that IS a comment (`key:   # why`) leaves the key with no value at
 * all, which is what opens the block underneath it.
 */
function stripComment(v) {
  if (v.startsWith('#')) return '';
  if (v.startsWith('"') || v.startsWith("'") || v.startsWith('[') || v.startsWith('{')) return v;
  const at = v.indexOf(' #');
  return at < 0 ? v : v.slice(0, at).trim();
}

function unquote(v, lineNo) {
  if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2)) {
    return v.slice(1, -1).replace(/\\(["\\/nrt])/g, (m, c) => ({ n: '\n', r: '\r', t: '\t' }[c] ?? c));
  }
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) return v.slice(1, -1).replace(/''/g, "'");
  if (v.startsWith('"') || v.startsWith("'")) throw new YamlRefusal(lineNo, 'an unterminated quoted scalar', v.slice(0, 40));
  return v;
}

/** A scalar: flow sequence, flow mapping, quoted, or plain. */
function scalar(v, lineNo) {
  if (v.startsWith('&') || v.startsWith('*')) {
    throw new YamlRefusal(lineNo, v.startsWith('&') ? 'an anchor' : 'an alias', v.split(/\s/)[0]);
  }
  if (v.startsWith('!')) throw new YamlRefusal(lineNo, 'an explicit tag', v.split(/\s/)[0]);
  if (v.startsWith('[')) return flowSeq(v, lineNo);
  if (v.startsWith('{')) return flowMap(v, lineNo);
  if (v.startsWith('"') || v.startsWith("'")) return unquote(v, lineNo);
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~') return null;
  if (/^-?\d+$/.test(v)) return Number(v);
  if (/^-?\d*\.\d+$/.test(v)) return Number(v);
  return v;
}

function flowSeq(v, lineNo) {
  if (!v.endsWith(']')) throw new YamlRefusal(lineNo, 'an unterminated flow sequence', v.slice(0, 40));
  const inner = v.slice(1, -1).trim();
  if (inner === '') return [];
  return splitFlow(inner, lineNo).map((x) => scalar(x, lineNo));
}

function flowMap(v, lineNo) {
  if (!v.endsWith('}')) throw new YamlRefusal(lineNo, 'an unterminated flow mapping', v.slice(0, 40));
  const inner = v.slice(1, -1).trim();
  const out = {};
  if (inner === '') return out;
  for (const part of splitFlow(inner, lineNo)) {
    const kv = splitKey(part, lineNo);
    if (!kv) throw new YamlRefusal(lineNo, 'a flow mapping entry with no key', part.slice(0, 40));
    out[kv.key] = scalar(kv.rest, lineNo);
  }
  return out;
}

/** Split a flow collection's body on commas that are not inside a quote or a nested flow. */
function splitFlow(inner, lineNo) {
  const out = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < inner.length; i += 1) {
    const c = inner[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '[' || c === '{') { depth += 1; continue; }
    if (c === ']' || c === '}') { depth -= 1; continue; }
    if (c === ',' && depth === 0) { out.push(inner.slice(start, i).trim()); start = i + 1; }
  }
  if (quote) throw new YamlRefusal(lineNo, 'an unterminated quoted scalar', inner.slice(0, 40));
  out.push(inner.slice(start).trim());
  return out.filter((x) => x !== '');
}

// ---------------------------------------------------------------------------
// Reading one document
// ---------------------------------------------------------------------------

/**
 * The path part of an OpenAPI 3 server URL.
 *
 * A TEMPLATE IS LEFT AS WRITTEN. `https://{host}/v1` gives `/v1`; `{scheme}://x/v1`
 * has no readable authority, so the whole string is kept and the routes under it
 * simply will not match anything the code serves. Substituting a variable's
 * default would invent a base path the document did not state.
 */
export function serverBasePath(url) {
  const s = String(url ?? '').trim();
  if (s === '') return '';
  const at = s.indexOf('://');
  if (at >= 0) {
    const afterAuthority = s.indexOf('/', at + 3);
    return afterAuthority < 0 ? '' : s.slice(afterAuthority);
  }
  return s;
}

const nonEmptyText = (v) => (typeof v === 'string' && v !== '' ? v : null);

/**
 * One operation as the document writes it. `resource` is the path key before
 * the base path is put in front, and `tags` are the operation's own: a code
 * generator names the interface an operation goes into from one or the other
 * (src/core/rules/kinds/java_contract_link.mjs), so both are kept as written.
 */
function operationEntry(verb, op, full, key) {
  return {
    method: verb.toUpperCase(),
    path: full,
    resource: key,
    operationId: nonEmptyText(op.operationId),
    summary: nonEmptyText(op.summary),
    tags: Array.isArray(op.tags) ? op.tags.filter((t) => typeof t === 'string') : [],
  };
}

/**
 * Read one OpenAPI / Swagger document.
 *
 * @param {string} text  the file's bytes as text
 * @param {{path?:string}} [opts]  the document's path, for the diagnostics
 * @returns {{path:string, version:('3'|'2'|'unknown'), basePath:string,
 *            paths:{method:string, path:string, resource:string, operationId:(string|null),
 *                   summary:(string|null), tags:string[]}[],
 *            unreadable:{line:number, construct:string, reason:string}[]}}
 */
export function readOpenApiDocument(text, opts = {}) {
  const path = String(opts.path ?? '');
  const out = { path, version: 'unknown', basePath: '', paths: [], unreadable: [] };
  const raw = String(text ?? '');
  const trimmed = raw.trimStart();
  const isJson = path.endsWith('.json') || trimmed.startsWith('{');

  let doc;
  if (isJson) {
    try { doc = JSON.parse(raw); }
    catch (e) {
      out.unreadable.push({ line: 1, construct: 'the JSON document', reason: `the document does not parse as JSON: ${e.message}` });
      return out;
    }
  } else {
    const r = readYamlSubset(raw);
    if (r.unreadable.length > 0) { out.unreadable = r.unreadable; return out; }
    doc = r.value;
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    out.unreadable.push({ line: 1, construct: 'the document root', reason: 'the document root is not a mapping, so it declares no routes' });
    return out;
  }

  if (typeof doc.openapi === 'string' && doc.openapi.startsWith('3')) out.version = '3';
  else if (typeof doc.swagger === 'string' && doc.swagger.startsWith('2')) out.version = '2';

  // Swagger 2 states its prefix outright; OpenAPI 3 folds it into the first
  // server URL, and the FIRST is the one taken: a document that lists several
  // servers is naming several deployments of the same API, not several APIs.
  if (out.version === '2') out.basePath = String(doc.basePath ?? '');
  else if (Array.isArray(doc.servers) && doc.servers.length > 0) {
    out.basePath = serverBasePath(doc.servers[0] && doc.servers[0].url);
  }

  const paths = doc.paths;
  if (!paths || typeof paths !== 'object' || Array.isArray(paths)) {
    out.unreadable.push({ line: 1, construct: 'the paths section', reason: 'the document has no `paths` mapping, so there is no route in it to read' });
    return out;
  }
  const base = String(out.basePath ?? '');
  for (const key of Object.keys(paths).sort()) {
    if (!key.startsWith('/')) continue;
    const item = paths[key];
    const full = normalizePath(`${base}${key}`);
    const verbs = (item && typeof item === 'object' && !Array.isArray(item))
      ? HTTP_VERBS.filter((v) => item[v] && typeof item[v] === 'object')
      : [];
    if (verbs.length === 0) {
      // A path item with no operation still DECLARES the path; the method is
      // unknown, and `ANY` is how this engine spells a route with no verb.
      out.paths.push({ method: ANY_METHOD, path: full, resource: key, operationId: null, summary: null, tags: [] });
      continue;
    }
    for (const v of verbs) out.paths.push(operationEntry(v, item[v], full, key));
  }
  out.paths.sort((a, b) => cmp(a.path, b.path) || cmp(a.method, b.method));
  return out;
}

/**
 * The documents read, each one the profile says is in step with this code
 * carrying the key that says so (`declaration`: `openapi.generatedFromCode` or
 * `openapi.generatesCode`), copied rather than changed. The source cannot say
 * a document is current; a person can, and the two readings that rest on a
 * document (src/adapters/java/functional_routes.mjs, ./contract_links.mjs)
 * grade by it.
 *
 * @param {object[]} documents  as `readOpenApiDocument` returns them
 * @param {Map<string,string>} declarations  a document's path -> the key (src/core/lanes.mjs openapiDeclarationsOf)
 */
export function withDeclarations(documents, declarations) {
  return (documents ?? []).map((d) => (declarations?.has(d.path) ? { ...d, declaration: declarations.get(d.path) } : d));
}

// ---------------------------------------------------------------------------
// The bridge
// ---------------------------------------------------------------------------

/**
 * Each document's routes, read once: which documents declare each route, what
 * the node shows of it, and each document's own row of the census.
 *
 * The node shows ONE operationId and ONE summary. What a rule pairs an
 * operation with is not read from here but from each document's own operations
 * (src/core/rules/kinds/java_contract_link.mjs, operationsOf), where a second
 * document's operationId on the same route is kept as its own.
 */
function readDeclarations(docs, served) {
  const declaredBy = new Map();  // endpoint id -> Set(document path)
  const meta = new Map();        // endpoint id -> {operationId, summary, path, httpMethod}
  const perDoc = [];
  const unreadable = [];
  for (const doc of docs.slice().sort((a, b) => cmp(a.path ?? '', b.path ?? ''))) {
    const row = {
      path: doc.path ?? '', version: doc.version ?? 'unknown', basePath: doc.basePath ?? '',
      paths: 0, matchedServed: 0, onlyInDocument: 0,
      unreadable: (doc.unreadable ?? []).slice(),
    };
    for (const u of row.unreadable) unreadable.push({ document: row.path, ...u });
    for (const p of doc.paths ?? []) {
      const id = openApiEndpointId(p.method, p.path);
      row.paths += 1;
      if (served.has(id)) row.matchedServed += 1; else row.onlyInDocument += 1;
      if (!declaredBy.has(id)) declaredBy.set(id, new Set());
      declaredBy.get(id).add(row.path);
      const prev = meta.get(id);
      meta.set(id, {
        httpMethod: p.method,
        path: p.path,
        // The FIRST document to say something keeps saying it: two documents
        // that disagree about a summary are a drift finding, not a race.
        operationId: prev && prev.operationId ? prev.operationId : (p.operationId ?? null),
        summary: prev && prev.summary ? prev.summary : (p.summary ?? null),
      });
    }
    perDoc.push(row);
  }
  return { declaredBy, meta, perDoc, unreadable };
}

/**
 * Put the documents' routes on the graph, and measure the drift between what is
 * declared and what is served.
 *
 * A route the code ALREADY serves gets no new node and no new edge: the document
 * is recorded on the node it corroborates (`declaredBy`, plus `operationId` and
 * `summary` when the document carries them), and the node keeps whatever the
 * code lane gave it. A route no code here serves becomes a node with `declared:
 * true` and no handler edge of the code's, because a declaration says a route
 * exists and says nothing about what runs below it.
 *
 * The one thing that may put a handler under such a route is a contract rule:
 * a controller implementing an interface the build generates from the document
 * (src/adapters/contract_links.mjs). It needs the Java lane's records, so it runs
 * only when `opts.java` and `opts.javaFacts` are given, and what it did is
 * `contractLinks` on the result, there only when it linked or named something.
 * The drift census is the code's own mappings against the documents, and a
 * guessed link does not move it.
 *
 * @param {import('../core/graph.mjs').Graph} g
 * @param {object[]} documents  as `readOpenApiDocument` returns them
 * @param {{java?:(object|null), javaFacts?:object[], registry?:object}} [opts]
 * @returns {{documents:object[], paths:number, matchedServed:number,
 *            onlyInDocument:number, onlyInCode:number, unreadable:object[],
 *            drift:{onlyInDocument:string[], onlyInCode:string[]}, contractLinks?:object}}
 */
export function addOpenApiRoutes(g, documents, opts = {}) {
  const docs = Array.isArray(documents) ? documents : [];
  // What the CODE serves, read before anything is added: a node with a handler
  // edge is a route this pack actually serves. An outbound node the web lane
  // invented for a URL nothing answers is NOT served, and must not be counted as
  // corroboration.
  const served = new Set();
  for (const [id, node] of g.nodes) {
    if (node.kind !== 'endpoint' || node.outbound === true) continue;
    served.add(id);
  }
  const { declaredBy, meta, perDoc, unreadable } = readDeclarations(docs, served);

  const onlyInDocument = [];
  for (const id of [...declaredBy.keys()].sort()) {
    const m = meta.get(id);
    const docsFor = [...declaredBy.get(id)].sort();
    const existing = g.nodes.get(id);
    if (existing) {
      existing.declaredBy = docsFor;
      if (m.operationId && !existing.operationId) existing.operationId = m.operationId;
      if (m.summary && !existing.summary) existing.summary = m.summary;
      if (!served.has(id)) onlyInDocument.push(id);
      continue;
    }
    g.addNode({
      id,
      path: m.path,
      httpMethod: m.httpMethod,
      source: 'openapi',
      declared: true,
      declaredBy: docsFor,
      ...(m.operationId ? { operationId: m.operationId } : {}),
      ...(m.summary ? { summary: m.summary } : {}),
    });
    onlyInDocument.push(id);
  }

  // The other direction, and it only means anything once a document was read: a
  // route the code serves that no document declares.
  const readAny = perDoc.some((d) => (d.unreadable ?? []).length === 0);
  const onlyInCode = readAny
    ? [...served].filter((id) => !declaredBy.has(id)).sort()
    : [];

  const contractLinks = opts.java && opts.javaFacts
    ? addContractLinks(g, docs, { javaFacts: opts.javaFacts, java: opts.java, registry: opts.registry ?? null }) : null;
  return {
    documents: perDoc,
    paths: perDoc.reduce((n, d) => n + d.paths, 0),
    matchedServed: perDoc.reduce((n, d) => n + d.matchedServed, 0),
    onlyInDocument: onlyInDocument.length,
    onlyInCode: onlyInCode.length,
    unreadable,
    drift: { onlyInDocument, onlyInCode },
    ...(contractLinks ? { contractLinks } : {}),
  };
}

export class OpenApiBridgeError extends Error {
  constructor(message) { super(message); this.name = 'OpenApiBridgeError'; }
}
