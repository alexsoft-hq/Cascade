// runtime_bridge.mjs — an execution trace as RUNTIME EVIDENCE on the dispatch
// axis (the RUNTIME_ONLY grade, the same posture the HAR bridge takes on the
// screen axis).
//
// WHY THIS LANE EXISTS. No reading of Java source can decide which
// implementation a call really reaches. A MyBatis mapper and a Spring Data
// repository are runtime proxies with no implementor in the source at all, and
// invariant I-1 keeps interface dispatch at SOUND_SET even when there is exactly
// one candidate, because a CGLIB/JDK proxy, a MyBatis interceptor, an `@DS`
// datasource switch or a `<if>` in the SQL can all make the runtime target
// differ from the one a compiler would name. The one thing static analysis
// cannot synthesize is the running program. A trace OBSERVES which
// implementation handled a request and which statement it ran, which is exactly
// the dispatch the static graph marks as a candidate SET.
//
// So this lane is additive, and it is treated the way a recording is:
//
//   - It is SHOWN, never WALKED. Every edge this bridge ADDS is RUNTIME_ONLY,
//     which sits below the floor of every query mode (src/core/graph.mjs), so no
//     chain, impact or census walk follows it.
//   - It never RAISES a grade. Where the static analysis already found the same
//     hop, that edge keeps the grade it had and gains `observed: true` and a
//     count beside it. SOUND_SET plus observed is still SOUND_SET.
//   - It never REMOVES or downgrades a candidate the trace did not visit. A
//     four-implementor dispatch where the trace saw one still has all four:
//     absence of observation is not absence of the path, because coverage is
//     only what was exercised.
//   - It is never DISCOVERED. `cascade analyze --otel <file>` or the profile's
//     `runtimeEvidence.otel` is a person saying "I captured this on purpose";
//     nothing here goes looking for a trace in the tree.
//
// WHAT IT READS. An OpenTelemetry trace export, in either of the two shapes a
// real capture comes in: an OTLP/JSON DOCUMENT (the `resourceSpans` shape a
// collector's file exporter, `otel-cli` and a Jaeger/Tempo API export write), or
// an application LOG with one export per line, which is what the Java agent's
// `logging-otlp` exporter writes into the app's own stdout. Which one a file is
// gets decided by reading it, never by its extension. Three span shapes carry
// something this lane can use, and every other span is counted as unusable
// rather than guessed at:
//
//   code.namespace + code.function     a METHOD ran, in a named concrete class
//   db.statement / db.query.text       a STATEMENT ran, with its SQL
//   http.route + http.method           an ENDPOINT was exercised
//
// WHAT IT WRITES. Nothing from a payload. A span's SQL text is read to recover
// the TABLE names it touched and is then dropped: `observedTables` goes on the
// statement node, the statement text does not, and no bound parameter is read at
// all. A trace this lane reads can therefore be taken from a running system
// without any of its data entering the pack.
//
// Pure: records in, graph mutated, statistics out. `readOtelTrace` is the one
// function that touches text, and it takes the text, not a path.

import { routeMatches, normalizeUrlPath } from './web_bridge.mjs';
import { symbolId } from './java_bridge.mjs';
import { nodeId } from '../core/graph.mjs';
import { caseId, GOLDEN_CASE_SCHEMA } from '../core/golden.mjs';

/** The attribute pair naming the class and method a span ran in. */
export const CODE_NAMESPACE_KEYS = Object.freeze(['code.namespace']);
/** `code.function` is the older spelling, `code.function.name` the newer one. */
export const CODE_FUNCTION_KEYS = Object.freeze(['code.function', 'code.function.name']);
/** `db.statement` is the older spelling, `db.query.text` the newer one. */
export const DB_STATEMENT_KEYS = Object.freeze(['db.statement', 'db.query.text']);
/** `http.method` is the older spelling, `http.request.method` the newer one. */
export const HTTP_METHOD_KEYS = Object.freeze(['http.method', 'http.request.method']);
/** The route TEMPLATE a server span served. `http.target` is a concrete path. */
export const HTTP_ROUTE_KEYS = Object.freeze(['http.route', 'http.target']);

/** How many unmatched observation keys the census lists. */
export const UNMATCHED_LISTED = 15;

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The plain value inside an OTLP `AnyValue`. Only the scalar shapes are read:
 * an array or a key-value list is not an identifier this lane can key a node by.
 * @param {unknown} v
 * @returns {string|null}
 */
export function attrValue(v) {
  if (v === null || typeof v !== 'object') return null;
  if (typeof v.stringValue === 'string') return v.stringValue;
  if (typeof v.intValue === 'string' || typeof v.intValue === 'number') return String(v.intValue);
  if (typeof v.doubleValue === 'number') return String(v.doubleValue);
  if (typeof v.boolValue === 'boolean') return String(v.boolValue);
  return null;
}

/**
 * A span's attributes as a plain map. OTLP writes them as a LIST of
 * `{key, value}`, so this is where that list becomes something a rule can read.
 * @param {unknown} attributes
 * @returns {Map<string,string>}
 */
export function attributesOf(attributes) {
  const out = new Map();
  for (const a of Array.isArray(attributes) ? attributes : []) {
    if (!a || typeof a !== 'object' || typeof a.key !== 'string') continue;
    const v = attrValue(a.value);
    if (v === null) continue;
    if (!out.has(a.key)) out.set(a.key, v);
  }
  return out;
}

const firstOf = (map, keys) => {
  for (const k of keys) {
    const v = map.get(k);
    if (typeof v === 'string' && v !== '') return v;
  }
  return null;
};

/**
 * The TABLES a SQL statement names, lower-cased, in the order they appear.
 *
 * This is deliberately a small reader and not a parser: the SQL lane already
 * has one, and this text is here to say WHICH table a dynamic statement really
 * chose, not to be re-analysed. It reads the name after FROM, JOIN, INTO,
 * UPDATE and DELETE FROM, which is what a `@DS` switch or an `<if>` changes.
 * Anything it cannot read stays unread rather than guessed.
 *
 * @param {string} sql
 * @returns {string[]} distinct table names, sorted
 */
export function tablesInSql(sql) {
  const text = String(sql ?? '').replace(/\s+/g, ' ');
  const out = new Set();
  const re = /\b(?:from|join|into|update)\s+([A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*)?)/gi;
  for (const m of text.matchAll(re)) {
    const name = m[1].toLowerCase();
    // `FROM (SELECT` and `FROM DUAL` name no table of this schema.
    if (name === 'dual' || name === 'select') continue;
    out.add(name);
  }
  return [...out].sort();
}

/** A span's UTC timestamp as ISO-8601, from an OTLP nanosecond string. */
export function spanTimeIso(nanos) {
  if (nanos === null || nanos === undefined) return null;
  const s = String(nanos);
  if (!/^\d+$/.test(s)) return null;
  const ms = Number(BigInt(s) / 1000000n);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms).toISOString();
}

/**
 * What ONE span carries that this lane can use, or null when it carries nothing.
 *
 * A span can be more than one thing at once: the JDBC span the Java agent writes
 * has the SQL on it and, when the mapper method is instrumented too, the class
 * and method as well. So this returns every facet it found rather than picking.
 *
 * @param {object} span  one OTLP span
 * @returns {{method:({type:string,name:string}|null), sql:(string|null),
 *            route:({httpMethod:string,path:string}|null)}}
 */
export function spanFacets(span) {
  const attrs = attributesOf(span && span.attributes);
  const ns = firstOf(attrs, CODE_NAMESPACE_KEYS);
  const fn = firstOf(attrs, CODE_FUNCTION_KEYS);
  const sql = firstOf(attrs, DB_STATEMENT_KEYS);
  const rawRoute = firstOf(attrs, HTTP_ROUTE_KEYS);
  const httpMethod = firstOf(attrs, HTTP_METHOD_KEYS);
  // `http.target` carries the query string; a route is a path.
  const route = rawRoute === null ? null : rawRoute.split('?')[0].split('#')[0];
  return {
    method: ns && fn ? { type: ns, name: fn } : null,
    sql: sql ?? null,
    // A route with no method is not addressable: an endpoint node is keyed by
    // "METHOD path", so half of the key is no key at all.
    route: route && httpMethod ? { httpMethod: httpMethod.toUpperCase(), path: normalizeUrlPath(route) } : null,
  };
}

/**
 * The `ResourceSpans` objects one line of an agent log carries, or null when the
 * line carries none.
 *
 * WHY THIS EXISTS. The Java agent's `logging-otlp` exporter does not write an
 * OTLP document. It writes ONE `ResourceSpans` object per export batch, as a
 * single line of the application's own log, behind the logger's prefix:
 *
 *   [otel.javaagent 2026-01-01 …] [BatchSpanProcessor…] INFO io.opentelemetry.
 *   exporter.logging.otlp.OtlpJsonLoggingSpanExporter - {"resource":{…},"scopeSpans":[…]}
 *
 * So the line is sliced at its FIRST `{` and parsed. Both shapes are accepted
 * there, because which one a line carries depends on the exporter and not on
 * anything the reader can see: a bare `ResourceSpans` (`resource` + a
 * `scopeSpans`/`instrumentationLibrarySpans` array) and a whole
 * `{"resourceSpans":[…]}` document, which is what a collector on the same line
 * would write. A prefix that carries a brace of its own gets one more attempt,
 * from the start of the resource object, and nothing beyond that.
 *
 * @param {string} line
 * @returns {object[]|null}  the ResourceSpans on this line, or null for a line
 *                           that carries no readable one
 */
function resourceSpansOnLine(line) {
  // The first `{` is where the JSON starts on every line the exporter writes.
  // The one exception worth handling is a logger whose own prefix contains a
  // brace (an MDC context, a thread name somebody templated), so if that slice
  // is not JSON, the start of a resource object is tried once more. Two
  // attempts, never a scan: a 45 KB line must not be parsed brace by brace.
  const starts = [];
  const first = line.indexOf('{');
  if (first < 0) return null;
  starts.push(first);
  for (const marker of ['{"resourceSpans"', '{"resource"']) {
    const at = line.indexOf(marker);
    if (at > first) starts.push(at);
  }
  for (const at of starts) {
    let obj;
    try {
      obj = JSON.parse(line.slice(at));
    } catch {
      continue;
    }
    if (!obj || typeof obj !== 'object') continue;
    if (Array.isArray(obj.resourceSpans)) return obj.resourceSpans;
    if (Array.isArray(obj.scopeSpans) || Array.isArray(obj.instrumentationLibrarySpans)) return [obj];
  }
  return null;
}

/**
 * Read one OpenTelemetry trace export. Text in, normalised observations out —
 * no filesystem here, so the caller decides what a path means.
 *
 * NEVER THROWS on bad input. A file that is not a trace comes back with
 * `unreadable` set and no observations, the way an unreadable recording does:
 * an analysis must not die because somebody passed the wrong file.
 *
 * TWO FORMS, TOLD APART BY CONTENT AND NEVER BY EXTENSION:
 *
 *   `form: 'document'`  the whole file is one OTLP/JSON document
 *                       (`{"resourceSpans":[…]}`), which is what a collector's
 *                       file exporter and a Jaeger or Tempo export write.
 *   `form: 'log'`       the file is an application LOG, one export per line,
 *                       each line prefixed by whatever the logger puts in front
 *                       of it. This is what the Java agent's `logging-otlp`
 *                       exporter produces, and it is the file a first user
 *                       actually has: the app's stdout. A line this reader
 *                       cannot use is SKIPPED and counted in `skippedLines`
 *                       (the banner, the framework's own log lines, a batch
 *                       truncated by a rotation), never fatal.
 *
 * The document is tried first, and the log pass runs only when it yields no
 * `resourceSpans`. `unreadable` is set only when NEITHER form found one. For a
 * one-line file it is the document reading's reason, because a one-line file is
 * only ever a document; for a file of several lines it names both readings, so
 * a reader can tell which of the two they meant to hand over.
 *
 * THE THREE NORMALISED SHAPES:
 *
 *   {kind:'dispatch', callerType, callerMethod, calleeType, calleeMethod,
 *    direct, count}
 *       a method span that ran INSIDE another method span. `direct` is true when
 *       the caller span is its immediate parent and false when framework spans
 *       sat in between, which is the difference between "the runtime nested
 *       these two" and "this ran somewhere below that".
 *   {kind:'statement', ownerType, method, sql, tables, count}
 *       a span carrying SQL. The owner and method are the span's own when it
 *       names them, and otherwise the nearest enclosing method span, which is
 *       how a JDBC span under a mapper method is attributed to that method.
 *   {kind:'endpoint', httpMethod, path, count}
 *       a server span naming the route it served.
 *
 * Observations are FOLDED by identity and counted, so a trace of ten thousand
 * requests through one chain is a handful of records with counts on them, and
 * the output is sorted, so the same trace always reads the same way.
 *
 * `routeTables` is the one thing folding by identity cannot say: WHICH tables a
 * request touched. It keeps one row per route with the tables of every SQL span
 * that ran under it (`foldRouteTables`), which is what a golden case built from
 * a trace needs.
 *
 * @param {string} text  the file's bytes as UTF-8
 * @param {{file?:string}} [opts]  the name to put on the evidence
 * @returns {{file:string, observations:object[], spans:number, usableSpans:number,
 *            unusable:number, services:string[], window:({from:string,to:string}|null),
 *            form:('document'|'log'|null), skippedLines:number, routeTables:object[],
 *            unreadable:(string|null)}}
 */
/**
 * 0. WHICH FORM IS THIS? A trace arrives as one OTLP document, as one JSON array
 * of them, or as JSON Lines — and a line that will not parse is COUNTED rather
 * than failing the whole file, because a capture truncated mid-line is the
 * normal way a recording ends.
 */
function readTraceForm(source, empty) {
// ---- 0. which form is this? --------------------------------------------
let resourceSpans = null;
let form = null;
let skippedLines = 0;
let docReason = null;
try {
  const doc = JSON.parse(source);
  if (doc && typeof doc === 'object' && Array.isArray(doc.resourceSpans)) {
    resourceSpans = doc.resourceSpans;
    form = 'document';
  } else {
    docReason = 'no resourceSpans array, so this is not an OTLP/JSON trace export';
  }
} catch (e) {
  docReason = `not JSON: ${e.message}`;
}
if (resourceSpans === null) {
  // THE LOG PASS. Every line stands on its own, so one unreadable line costs
  // that line and nothing else: a log is a stream somebody may have truncated,
  // rotated or interleaved with another thread's output.
  const collected = [];
  let skipped = 0;
  let read = 0;
  for (const line of source.split('\n')) {
    if (line.trim() === '') continue;
    read += 1;
    const found = resourceSpansOnLine(line);
    if (found === null) { skipped += 1; continue; }
    for (const rs of found) collected.push(rs);
  }
  if (collected.length > 0) {
    resourceSpans = collected;
    form = 'log';
    skippedLines = skipped;
  } else if (read > 1) {
    // Several lines and not one export. Reporting only the document reading's
    // complaint here would be misleading, because a log is not a broken
    // document: it is a file that was read the other way and still had
    // nothing in it. Both readings are named, so a reader can tell which file
    // they pointed at.
    docReason = `no OTLP export in this file. As one document: ${docReason}. `
      + `As an agent log: ${read} line(s) read, none of them carrying a ResourceSpans`;
  }
}
if (resourceSpans === null) return { resourceSpans: null, form, skippedLines, unreadable: empty(docReason) };

  return { resourceSpans, form, skippedLines, unreadable: null };
}

/**
 * 1. EVERY SPAN, FLATTENED, with its facets read once. The order is the order
 * the document gave, which is what makes two readings of one capture agree.
 */
function flattenSpans(resourceSpans) {
// ---- 1. every span, flattened, with its facets read once ----------------
const spans = new Map(); // spanId -> {id, parentId, facets, at}
const order = []; // insertion order, so a trace with no ids still reads stably
const services = new Set();
let total = 0;
for (const rs of resourceSpans) {
  if (!rs || typeof rs !== 'object') continue;
  const resAttrs = attributesOf(rs.resource && rs.resource.attributes);
  const service = resAttrs.get('service.name');
  if (typeof service === 'string' && service !== '') services.add(service);
  // `scopeSpans` is the current spelling; `instrumentationLibrarySpans` is
  // what an older collector wrote, and a trace exported by one is still a
  // trace.
  const scopes = Array.isArray(rs.scopeSpans) ? rs.scopeSpans
    : Array.isArray(rs.instrumentationLibrarySpans) ? rs.instrumentationLibrarySpans : [];
  for (const sc of scopes) {
    if (!sc || typeof sc !== 'object' || !Array.isArray(sc.spans)) continue;
    for (const sp of sc.spans) {
      if (!sp || typeof sp !== 'object') continue;
      total += 1;
      const id = typeof sp.spanId === 'string' && sp.spanId !== '' ? sp.spanId : `#${total}`;
      const parentId = typeof sp.parentSpanId === 'string' && sp.parentSpanId !== '' ? sp.parentSpanId : null;
      const rec = {
        id,
        parentId,
        facets: spanFacets(sp),
        at: spanTimeIso(sp.startTimeUnixNano),
      };
      if (!spans.has(id)) { spans.set(id, rec); order.push(id); }
    }
  }
}

  return { spans, order, services, total };
}

/**
 * 2. THE NEAREST ENCLOSING METHOD SPAN of each span: a SQL span belongs to the
 * method that ran it, and the parent chain is the only thing that says which.
 */
function methodAncestors(spans) {
// ---- 2. the nearest enclosing METHOD span, for each span ----------------
// A trace nests a service method under a controller method under an HTTP
// span, and often under a framework span nobody instrumented as a method.
// "Who ran this?" is therefore the nearest ANCESTOR that names a method, and
// whether that ancestor was the immediate parent is recorded rather than
// assumed: only a direct nesting is evidence enough to draw a NEW edge.
const methodAncestorOf = (rec) => {
  let hops = 0;
  let cur = rec.parentId === null ? null : spans.get(rec.parentId) ?? null;
  const seen = new Set([rec.id]);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    if (cur.facets.method) return { span: cur, direct: hops === 0 };
    hops += 1;
    cur = cur.parentId === null ? null : spans.get(cur.parentId) ?? null;
  }
  return null;
};

  return methodAncestorOf;
}

/**
 * 3. THE SPANS, FOLDED INTO COUNTED OBSERVATIONS. One row per thing observed,
 * with how many times it was seen and the window it was seen in — a trace is
 * evidence of what RAN, and the count is part of the evidence.
 */
function foldObservations(ctx) {
  const { file, form, spans, order, services, total, methodAncestorOf, skippedLines } = ctx;
// ---- 3. fold the spans into counted observations ------------------------
const folded = new Map(); // key -> observation
let usable = 0;
let from = null;
let to = null;
const bump = (key, make) => {
  let o = folded.get(key);
  if (!o) { o = make(); folded.set(key, o); }
  o.count += 1;
  return o;
};
for (const id of order) {
  const rec = spans.get(id);
  const f = rec.facets;
  // USABLE means the span carried an attribute this lane reads. A usable span
  // can still produce no observation (a method span with no method above it
  // names no caller), and the two are counted apart so "unusable" keeps
  // meaning "this lane could read nothing on it" and never "this lane chose
  // not to use it".
  const used = !!(f.route || f.method || f.sql !== null);
  if (f.route) {
    bump(`e|${f.route.httpMethod}|${f.route.path}`, () => ({
      kind: 'endpoint', httpMethod: f.route.httpMethod, path: f.route.path, count: 0,
    }));
  }
  if (f.method) {
    const anc = methodAncestorOf(rec);
    if (anc) {
      const caller = anc.span.facets.method;
      const key = `d|${caller.type}#${caller.name}|${f.method.type}#${f.method.name}`;
      const o = bump(key, () => ({
        kind: 'dispatch',
        callerType: caller.type, callerMethod: caller.name,
        calleeType: f.method.type, calleeMethod: f.method.name,
        direct: anc.direct,
        count: 0,
      }));
      // A pair seen directly nested even once IS directly nested: the weaker
      // reading must not erase the stronger one.
      if (anc.direct) o.direct = true;
    }
    // A method span with no method span above it is the entry of the trace:
    // it says a method ran and names no caller, so there is no dispatch to
    // observe and nothing is invented for it.
  }
  if (f.sql !== null) {
    const own = f.method;
    const anc = own ? null : methodAncestorOf(rec);
    const owner = own ?? (anc ? anc.span.facets.method : null);
    const tables = tablesInSql(f.sql);
    if (owner || tables.length > 0) {
      const key = `s|${owner ? `${owner.type}.${owner.name}` : ''}|${tables.join(',')}`;
      bump(key, () => ({
        kind: 'statement',
        ownerType: owner ? owner.type : null,
        method: owner ? owner.name : null,
        sql: f.sql,
        tables,
        count: 0,
      }));
    }
  }
  if (used) {
    usable += 1;
    if (rec.at !== null) {
      if (from === null || rec.at < from) from = rec.at;
      if (to === null || rec.at > to) to = rec.at;
    }
  }
}

// Sorted by kind then key: the same trace must read the same way every run,
// whatever order a collector happened to write the spans in.
const observations = [...folded.entries()]
  .sort((a, b) => cmp(a[0], b[0]))
  .map(([, o]) => o);

return {
  file,
  observations,
  spans: total,
  usableSpans: usable,
  unusable: total - usable,
  services: [...services].sort(),
  window: from !== null && to !== null ? { from, to } : null,
  form,
  skippedLines,
  unreadable: null,
};
}


/**
 * 4. WHAT RAN UNDER EACH REQUEST. The folded observations above are keyed by
 * WHAT was seen and lose WHERE it was seen, and one question needs that: which
 * tables did a request touch? So this walks each SQL span's parent chain up to
 * the nearest server span and puts the tables in that route's bucket.
 *
 * A SQL span with no route above it belongs to no request — a startup seed, a
 * scheduled job, a warm-up — and is left out rather than attributed to whichever
 * route ran next. A route with no SQL under it keeps an empty table list, which
 * is the honest record of a request that read nothing.
 *
 * @param {Map<string,object>} spans
 * @param {string[]} order
 * @returns {{httpMethod:string, path:string, tables:string[], requests:number,
 *            statementSpans:number}[]}  sorted by method then path
 */
function foldRouteTables(spans, order) {
  const routeAncestorOf = (rec) => {
    let cur = rec;
    const seen = new Set();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      if (cur.facets.route) return cur.facets.route;
      cur = cur.parentId === null ? null : spans.get(cur.parentId) ?? null;
    }
    return null;
  };
  const buckets = new Map(); // "METHOD path" -> {httpMethod, path, tables:Set, ...}
  const bucket = (route) => {
    const key = `${route.httpMethod} ${route.path}`;
    let b = buckets.get(key);
    if (!b) {
      b = { httpMethod: route.httpMethod, path: route.path, tables: new Set(), requests: 0, statementSpans: 0 };
      buckets.set(key, b);
    }
    return b;
  };
  for (const id of order) {
    const rec = spans.get(id);
    if (rec.facets.route) bucket(rec.facets.route).requests += 1;
    if (rec.facets.sql === null) continue;
    const route = routeAncestorOf(rec);
    if (!route) continue;
    const b = bucket(route);
    b.statementSpans += 1;
    for (const t of tablesInSql(rec.facets.sql)) b.tables.add(t);
  }
  return [...buckets.entries()]
    .sort((a, b) => cmp(a[0], b[0]))
    .map(([, b]) => ({ ...b, tables: [...b.tables].sort() }));
}


export function readOtelTrace(text, opts = {}) {
  const file = typeof opts.file === 'string' ? opts.file : '(otel)';
  const empty = (unreadable) => ({
    file, observations: [], spans: 0, usableSpans: 0, unusable: 0, services: [], window: null,
    form: null, skippedLines: 0, routeTables: [], unreadable,
  });
  const source = String(text);

  const { resourceSpans, form, skippedLines, unreadable } = readTraceForm(source, empty);
  if (unreadable) return unreadable;
  const { spans, order, services, total } = flattenSpans(resourceSpans);
  const methodAncestorOf = methodAncestors(spans);
  const folded = foldObservations({
    file, form, spans, order, services, total, methodAncestorOf, skippedLines,
  });
  return { ...folded, routeTables: foldRouteTables(spans, order) };
}


/**
 * Attach one or more traces to a graph that already holds this pack's symbols,
 * statements and routes.
 *
 * THE THREE JOINS, and what each one is allowed to do:
 *
 *  1. DISPATCH. `caller ran callee` is looked for in the graph in two shapes,
 *     in this order:
 *       a. a direct `caller --MAY_CALL--> callee` edge. The static lane already
 *          had it: mark it observed, leave its grade alone.
 *       b. `caller --MAY_CALL--> iface#m --MAY_CALL--> callee`, where `m` is the
 *          method the trace saw. That is the interface-dispatch candidate set,
 *          and the trace has just named WHICH member of it ran. The dispatch
 *          edge and the call into the interface both become observed, and both
 *          keep their SOUND_SET grade: seen once is not always.
 *     Only when neither shape exists, and only when the trace nested the two
 *     spans DIRECTLY, and only when both symbols are already nodes of this pack,
 *     is a new `MAY_CALL` edge written, graded RUNTIME_ONLY. Everything else is
 *     counted as unmatched, because a symbol this pack never saw is not a symbol
 *     this bridge may invent.
 *  2. STATEMENT. A statement observation names a mapper method, so the statement
 *     node `owner.method` is looked up directly. The node and the
 *     `IMPLEMENTS_STMT` edge into it are marked observed, and the tables the SQL
 *     really named go on the node as `observedTables`. The statically derived
 *     EXECUTES edges are NOT touched: a table the run chose and the source did
 *     not is a finding to show, never a correction to apply.
 *  3. ENDPOINT. A route observation is matched against the routes this pack
 *     serves, by exact path first and then through the route template, and marks
 *     the endpoint node observed.
 *
 * @param {import('../core/graph.mjs').Graph} g
 * @param {ReturnType<typeof readOtelTrace>[]} traces
 * @param {{unmatchedListed?:number}} [opts]
 * @returns {object} the census (see `stats` below)
 */
/**
 * WHAT A TRACE SAW, folded onto the graph's own edges and nodes. Nothing is
 * added to the graph here: this only counts, so the same observation seen in
 * three files is one mark with a count of three and three file names.
 */
function collectMarks(g, traces, ctx) {
  const {
    allRoutes, routesByPath, noteUnmatched, stats, services, edgeMarks, nodeMarks, added,
  } = ctx;
  const markEdge = (idx, count, file, rule) => {
    let m = edgeMarks.get(idx);
    if (!m) { m = { count: 0, files: new Set(), rule }; edgeMarks.set(idx, m); }
    m.count += count;
    m.files.add(file);
  };
  const markNode = (id, count, file, tables) => {
    let m = nodeMarks.get(id);
    if (!m) { m = { count: 0, files: new Set(), tables: new Set() }; nodeMarks.set(id, m); }
    m.count += count;
    m.files.add(file);
    for (const t of tables ?? []) m.tables.add(t);
  };

  /** The MAY_CALL edge index from `fromId` to `toId`, or null. */
  const callEdge = (fromId, toId) => {
    for (const e of g.outEdges(fromId)) {
      if (e.type === 'MAY_CALL' && e.to === toId) return e.idx;
    }
    return null;
  };

  let from = null;
  let to = null;

const list = Array.isArray(traces) ? traces : [];
for (const rec of list) {
  if (!rec || typeof rec !== 'object') continue;
  stats.files += 1;
  if (rec.unreadable) {
    stats.unreadable.push({ file: rec.file, reason: rec.unreadable });
    continue;
  }
  stats.sources.push(rec.file);
  stats.spans += rec.spans ?? 0;
  stats.usableSpans += rec.usableSpans ?? 0;
  stats.unusable += rec.unusable ?? 0;
  for (const s of rec.services ?? []) services.add(s);
  if (rec.window) {
    if (from === null || rec.window.from < from) from = rec.window.from;
    if (to === null || rec.window.to > to) to = rec.window.to;
  }
  for (const o of rec.observations ?? []) {
    stats.observations += 1;
    if (o.kind === 'endpoint') {
      const hit = matchRoute(routesByPath, allRoutes, o.path, o.httpMethod);
      if (!hit) { noteUnmatched('endpoint', `${o.httpMethod} ${o.path}`); continue; }
      stats.matched.endpoint += 1;
      markNode(hit.id, o.count, rec.file, null);
      continue;
    }
    if (o.kind === 'statement') {
      if (o.ownerType === null || o.method === null) {
        // SQL with no method above it. The statement it belongs to is not
        // knowable from the trace, so it is counted and named by the tables
        // it touched, never guessed onto a statement node.
        noteUnmatched('statement', `(no mapper method) ${o.tables.join(', ') || '(no table read)'}`);
        continue;
      }
      const stmtId = nodeId('statement', `${o.ownerType}.${o.method}`);
      if (!g.nodes.has(stmtId)) { noteUnmatched('statement', `${o.ownerType}.${o.method}`); continue; }
      stats.matched.statement += 1;
      markNode(stmtId, o.count, rec.file, o.tables);
      // The mapper method that runs it, so a reader looking at the CODE side
      // sees the same mark as one looking at the SQL side.
      const symId = symbolId(`${o.ownerType}#${o.method}`);
      if (g.nodes.has(symId)) {
        markNode(symId, o.count, rec.file, null);
        for (const e of g.outEdges(symId)) {
          if (e.type === 'IMPLEMENTS_STMT' && e.to === stmtId) markEdge(e.idx, o.count, rec.file, 'otel-statement');
        }
      }
      continue;
    }
    if (o.kind !== 'dispatch') continue;
    const callerId = symbolId(`${o.callerType}#${o.callerMethod}`);
    const calleeId = symbolId(`${o.calleeType}#${o.calleeMethod}`);
    const direct = callEdge(callerId, calleeId);
    if (direct !== null) {
      stats.matched.dispatch += 1;
      stats.dispatchDirect += 1;
      markEdge(direct, o.count, rec.file, 'otel-dispatch');
      markNode(calleeId, o.count, rec.file, null);
      continue;
    }
    // THE CANDIDATE SET, NARROWED. The trace ran the concrete class; the
    // static graph reached it through the interface. Both hops are marked,
    // and neither changes grade.
    const viaIface = interfaceHop(g, callerId, calleeId, o.calleeMethod);
    if (viaIface) {
      stats.matched.dispatch += 1;
      stats.dispatchThroughInterface += 1;
      markEdge(viaIface.intoIface, o.count, rec.file, 'otel-dispatch');
      markEdge(viaIface.dispatch, o.count, rec.file, 'otel-dispatch');
      markNode(calleeId, o.count, rec.file, null);
      continue;
    }
    // NOTHING STATIC EXPLAINS IT. A new edge is written only where the trace
    // nested the two spans directly and this pack already holds both symbols;
    // anything else is counted, so a reader can see what the trace saw that
    // this analysis could not place.
    if (o.direct && g.nodes.has(callerId) && g.nodes.has(calleeId)) {
      const key = `${callerId}|${calleeId}`;
      let a = added.get(key);
      if (!a) { a = { from: callerId, to: calleeId, count: 0, files: new Set() }; added.set(key, a); }
      a.count += o.count;
      a.files.add(rec.file);
      stats.matched.dispatch += 1;
      continue;
    }
    noteUnmatched('dispatch', `${o.callerType}#${o.callerMethod} -> ${o.calleeType}#${o.calleeMethod}`);
  }
}
  return { from, to };
}


export function addRuntimeFacts(g, traces, opts = {}) {
  const listed = Number.isInteger(opts.unmatchedListed) && opts.unmatchedListed > 0
    ? opts.unmatchedListed : UNMATCHED_LISTED;
  const stats = {
    files: 0,
    spans: 0,
    usableSpans: 0,
    unusable: 0,
    observations: 0,
    matched: { dispatch: 0, statement: 0, endpoint: 0 },
    unmatched: { dispatch: 0, statement: 0, endpoint: 0 },
    dispatchDirect: 0,
    dispatchThroughInterface: 0,
    edgesObserved: 0,
    edgesAdded: 0,
    statementsObserved: 0,
    endpointsObserved: 0,
    tablesOnlyAtRunTime: 0,
    window: null,
    services: [],
    sources: [],
    unmatchedKeys: [],
    unreadable: [],
  };

  // The routes this pack SERVES, keyed the way the web and HAR bridges key them.
  const { routesByPath, allRoutes } = servedRouteIndex(g);

  const unmatched = new Map();
  const noteUnmatched = (kind, key) => {
    stats.unmatched[kind] += 1;
    const k = `${kind}|${key}`;
    unmatched.set(k, (unmatched.get(k) ?? 0) + 1);
  };

  // The observed marks, accumulated across every trace before anything is
  // written, so two traces of the same chain make ONE mark with the sum on it
  // rather than the last file's count.
  const edgeMarks = new Map(); // edge index -> {count, files:Set, rule}
  const nodeMarks = new Map(); // node id -> {count, files:Set, tables:Set}
  const added = new Map(); // "from|to" -> {from, to, count, files:Set, spans:number}
  const services = new Set();

  const window = collectMarks(g, traces, {
    allRoutes, routesByPath, noteUnmatched, stats, services, edgeMarks, nodeMarks, added,
  });
  const { from, to } = window;

  // ---- write, in a fixed order -------------------------------------------
  for (const idx of [...edgeMarks.keys()].sort((a, b) => a - b)) {
    const m = edgeMarks.get(idx);
    const e = g.edges[idx];
    if (!e) continue;
    // A NEW evidence object every time, never a mutation of the one the static
    // lane handed over: the grade and the rule that produced it stay exactly as
    // they were, and `observed` is added beside them.
    e.evidence = {
      ...(e.evidence ?? {}),
      observed: true,
      observedCount: m.count,
      observedBy: [...m.files].sort(),
    };
    stats.edgesObserved += 1;
  }
  for (const id of [...nodeMarks.keys()].sort()) {
    const m = nodeMarks.get(id);
    if (!g.nodes.has(id)) continue;
    const n = g.nodes.get(id);
    const tables = [...m.tables].sort();
    // WHAT THE RUN TOUCHED AND THE SOURCE DID NOT. Recorded beside the
    // statically derived tables, never instead of them.
    const staticTables = n.kind === 'statement'
      ? g.outEdges(id).filter((e) => e.type === 'EXECUTES').map((e) => e.to.slice('table:'.length))
      : [];
    const extra = tables.filter((t) => !staticTables.includes(t) && !staticTables.includes(t.split('.').pop()));
    g.addNode({
      id,
      observed: true,
      observedCount: m.count,
      ...(tables.length > 0 ? { observedTables: tables } : {}),
    });
    if (extra.length > 0) stats.tablesOnlyAtRunTime += extra.length;
    if (n.kind === 'statement') stats.statementsObserved += 1;
    if (n.kind === 'endpoint') stats.endpointsObserved += 1;
  }
  for (const key of [...added.keys()].sort()) {
    const a = added.get(key);
    g.addEdge({
      from: a.from,
      to: a.to,
      type: 'MAY_CALL',
      grade: 'RUNTIME_ONLY',
      evidence: {
        rule: 'otel-runtime-only',
        basis: 'a trace nested these two method spans directly and no static rule connects them, so this says the callee RAN INSIDE the caller at run time, not that the source calls it. RUNTIME_ONLY is below every mode floor, so it is shown and never walked',
        observed: true,
        observedCount: a.count,
        observedBy: [...a.files].sort(),
      },
    });
    stats.edgesAdded += 1;
  }

  stats.window = from !== null && to !== null ? { from, to } : null;
  stats.services = [...services].sort();
  stats.sources = [...new Set(stats.sources)].sort();
  stats.unmatchedKeys = [...unmatched.entries()]
    .sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))
    .slice(0, listed)
    .map(([k, count]) => {
      const bar = k.indexOf('|');
      return { kind: k.slice(0, bar), key: k.slice(bar + 1), count };
    });
  return stats;
}

/**
 * The routes this pack SERVES, indexed for `matchRoute`. One reading of the
 * graph, shared by the census and by the golden fold, so the two can never come
 * to different conclusions about which endpoint a recorded route is.
 *
 * @param {import('../core/graph.mjs').Graph} g
 * @returns {{routesByPath:Map<string,{id:string,httpMethod:string}[]>, allRoutes:string[]}}
 */
function servedRouteIndex(g) {
  const routesByPath = new Map();
  const allRoutes = [];
  for (const n of g.nodes.values()) {
    if (n.kind !== 'endpoint' || n.outbound === true || typeof n.path !== 'string') continue;
    const p = normalizeUrlPath(n.path);
    if (!routesByPath.has(p)) { routesByPath.set(p, []); allRoutes.push(p); }
    routesByPath.get(p).push({ id: n.id, httpMethod: n.httpMethod ?? 'ANY' });
  }
  allRoutes.sort();
  return { routesByPath, allRoutes };
}

/**
 * The route this pack serves that a recorded route names: exact path first, then
 * through the route TEMPLATE, so `/brand/detail/42` reaches `/brand/detail/{id}`.
 * @returns {{id:string, httpMethod:string}|null}
 */
function matchRoute(routesByPath, allRoutes, path, httpMethod) {
  const methodOk = (r) => r.httpMethod === 'ANY' || r.httpMethod === httpMethod;
  const exact = (routesByPath.get(path) ?? []).filter(methodOk);
  if (exact.length > 0) return exact[0];
  for (const rp of allRoutes) {
    if (rp === path || !routeMatches(rp, path)) continue;
    const hit = routesByPath.get(rp).filter(methodOk);
    if (hit.length > 0) return hit[0];
  }
  return null;
}

// ---------------------------------------------------------------------------
// GOLDEN CASES FROM A TRACE
//
// A project golden needs LABELS somebody did not read off the analyzer, and the
// running program is the one source of those. What execution can witness is
// REACH: this route ran, and these tables were touched under it. So a case built
// here carries positives and NO negatives, and scores recall only — a request
// that did not touch a table proves nothing about whether it could have.
//
// The matching is the census's own (`servedRouteIndex` + `matchRoute`, and the
// statement/symbol node ids `addRuntimeFacts` looks up), so a route this fold
// calls "the GET /owners endpoint" is the same node the runtime marks observed.
// ---------------------------------------------------------------------------

/** The node key a case's input and expectation use: the id minus its kind. */
const keyOf = (id) => String(id).slice(String(id).indexOf(':') + 1);

/**
 * The accumulator the fold below writes into: one case per (relation, input),
 * merged across every observation and every trace that witnessed it.
 *
 * MERGED, NOT LAST-ONE-WINS. Two requests through one route, or two traces from
 * two days, are one case whose expectation is the UNION of what was seen: every
 * table either request touched really was touched. The counts add up and the
 * window widens, so the case still says how much running it rests on.
 *
 * @param {string} packDigest  the pack the ids were matched against
 */
function caseFold(packDigest) {
  const rows = new Map();
  return {
    add(relation, input, present, from) {
      const id = caseId({ relation, input });
      let r = rows.get(id);
      if (!r) {
        r = { id, relation, input, present: new Set(), files: new Set(), spans: 0, observed: 0, from: null, to: null };
        rows.set(id, r);
      }
      for (const p of present) r.present.add(p);
      r.files.add(from.file);
      r.spans += from.spans ?? 0;
      r.observed += from.observed ?? 0;
      if (from.window) {
        if (r.from === null || from.window.from < r.from) r.from = from.window.from;
        if (r.to === null || from.window.to > r.to) r.to = from.window.to;
      }
      return r;
    },
    cases() {
      return [...rows.values()].sort((a, b) => cmp(a.id, b.id)).map((r) => ({
        schema: GOLDEN_CASE_SCHEMA,
        id: r.id,
        relation: r.relation,
        input: r.input,
        // NO NEGATIVES, EVER, from a trace: `absent` is the list a precision
        // number is made of, and execution cannot fill it in. A case with an
        // empty `absent` scores recall and leaves precision unproven.
        expect: { present: [...r.present].sort(), absent: [] },
        source: 'runtime',
        proposed: true,
        approvedAt: null,
        proposedFrom: {
          packDigest,
          tool: 'otel',
          file: [...r.files].sort()[0],
          traces: r.files.size,
          spans: r.spans,
          observed: r.observed,
          window: r.from !== null && r.to !== null ? { from: r.from, to: r.to } : null,
        },
      }));
    },
  };
}

/**
 * Fold one trace's ROUTES into `endpoint->tables` cases: for every route this
 * pack serves, the tables of every SQL span that ran under a request to it.
 *
 * A route the pack does not serve is COUNTED, never invented: a trace of another
 * service, an actuator endpoint, a route added after this pack was built.
 */
function foldRouteCases(rec, fold, ctx) {
  const { routesByPath, allRoutes, stats, unmatched } = ctx;
  for (const row of rec.routeTables ?? []) {
    const hit = matchRoute(routesByPath, allRoutes, row.path, row.httpMethod);
    if (!hit) {
      stats.unmatched.endpoint += 1;
      const k = `endpoint|${row.httpMethod} ${row.path}`;
      unmatched.set(k, (unmatched.get(k) ?? 0) + 1);
      continue;
    }
    fold.add('endpoint->tables', { endpoint: keyOf(hit.id) }, row.tables, {
      file: rec.file, spans: row.statementSpans, observed: row.requests, window: rec.window,
    });
    stats.routes += 1;
    if (row.tables.length === 0) stats.routesWithNoStatement += 1;
  }
}

/**
 * Fold one trace's STATEMENT observations into `method->statements` cases: the
 * method a SQL span ran inside, and the statement node named after it.
 *
 * The owner is the NEAREST enclosing method span (`readOtelTrace` decided that),
 * which is what the relation is about: the statements a method BINDS, not
 * everything its call chain eventually reaches.
 */
function foldStatementCases(rec, fold, ctx) {
  const { g, stats, unmatched } = ctx;
  for (const o of rec.observations ?? []) {
    if (o.kind !== 'statement') continue;
    const note = (key) => {
      stats.unmatched.statement += 1;
      const k = `statement|${key}`;
      unmatched.set(k, (unmatched.get(k) ?? 0) + 1);
    };
    if (o.ownerType === null || o.method === null) {
      note(`(no method above this SQL) ${o.tables.join(', ') || '(no table read)'}`);
      continue;
    }
    const member = `${o.ownerType}#${o.method}`;
    const stmtId = nodeId('statement', `${o.ownerType}.${o.method}`);
    if (!g.nodes.has(symbolId(member)) || !g.nodes.has(stmtId)) { note(member); continue; }
    fold.add('method->statements', { symbol: member }, [keyOf(stmtId)], {
      file: rec.file, spans: o.count, observed: o.count, window: rec.window,
    });
    stats.statements += 1;
  }
}

/**
 * Golden cases proposed from execution: every trace's routes and statements,
 * matched to this pack and folded into cases a human can approve.
 *
 * The two relations a trace can label are the two execution can witness. The
 * other two (`column->endpoints`, `statement->columns`) are questions about what
 * a change WOULD reach and what a statement touches, and no single run answers
 * either, so nothing is proposed for them and the caller says so out loud.
 *
 * @param {import('../core/graph.mjs').Graph} g
 * @param {ReturnType<typeof readOtelTrace>[]} traces
 * @param {{packDigest:string, unmatchedListed?:number}} opts
 * @returns {{cases:object[], relations:Object, unmatchedKeys:object[],
 *            unreadable:object[], stats:Object}}
 */
export function otelGoldenCases(g, traces, opts = {}) {
  const listed = Number.isInteger(opts.unmatchedListed) && opts.unmatchedListed > 0
    ? opts.unmatchedListed : UNMATCHED_LISTED;
  const fold = caseFold(typeof opts.packDigest === 'string' ? opts.packDigest : '');
  const stats = {
    files: 0, routes: 0, statements: 0, routesWithNoStatement: 0,
    unmatched: { endpoint: 0, statement: 0 },
  };
  const unmatched = new Map();
  const unreadable = [];
  const { routesByPath, allRoutes } = servedRouteIndex(g);
  const ctx = { g, routesByPath, allRoutes, stats, unmatched };
  for (const rec of Array.isArray(traces) ? traces : []) {
    if (!rec || typeof rec !== 'object') continue;
    stats.files += 1;
    if (rec.unreadable) { unreadable.push({ file: rec.file, reason: rec.unreadable }); continue; }
    foldRouteCases(rec, fold, ctx);
    foldStatementCases(rec, fold, ctx);
  }
  const cases = fold.cases();
  const relations = {};
  for (const c of cases) {
    const r = relations[c.relation] ?? (relations[c.relation] = { cases: 0, present: 0, empty: 0 });
    r.cases += 1;
    r.present += c.expect.present.length;
    if (c.expect.present.length === 0) r.empty += 1;
  }
  const unmatchedKeys = [...unmatched.entries()]
    .sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))
    .slice(0, listed)
    .map(([k, count]) => ({ kind: k.slice(0, k.indexOf('|')), key: k.slice(k.indexOf('|') + 1), count }));
  return { cases, relations, unmatchedKeys, unreadable, stats };
}

/**
 * The two-hop path `caller --MAY_CALL--> iface#method --MAY_CALL--> callee`, if
 * the graph has one. That shape IS the interface-dispatch candidate set the Java
 * lane writes, so finding it is how a trace names which candidate really ran.
 * @returns {{intoIface:number, dispatch:number}|null}  the two edge indexes
 */
function interfaceHop(g, callerId, calleeId, calleeMethod) {
  const wanted = `#${calleeMethod}`;
  for (const mid of g.outEdges(callerId)) {
    if (mid.type !== 'MAY_CALL' || !mid.to.endsWith(wanted)) continue;
    if (mid.to === calleeId) continue; // the direct case, already tried
    for (const down of g.outEdges(mid.to)) {
      if (down.type === 'MAY_CALL' && down.to === calleeId) {
        return { intoIface: mid.idx, dispatch: down.idx };
      }
    }
  }
  return null;
}

/**
 * The methods an OpenTelemetry Java agent has to be told to instrument before
 * the DISPATCH join can see anything, read off the pack itself.
 *
 * WHY THE PACK ANSWERS THIS. Out of the box the agent writes HTTP server spans,
 * repository spans and JDBC spans, so the endpoint and statement joins fill up
 * on the first run and dispatch stays at zero: no controller and no service
 * method has a span, so no method span ever nests inside another one. The agent
 * can add them, through `otel.instrumentation.methods.include`, and it takes
 * EXPLICIT method names in the form `pkg.Class[m1,m2]`. A wildcard is not a
 * name: `pkg.Class[*]` matches nothing and the run comes back as empty as
 * before. So somebody has to write the list, and the pack already holds exactly
 * the symbols that belong on it.
 *
 * WHAT GOES ON THE LIST, and why each half is there:
 *
 *   - every HANDLER (a `HANDLES` target). That is the top of a request, and it
 *     is the caller side of the first hop the join needs.
 *   - every symbol that REACHES A STATEMENT: the method that implements one
 *     (`IMPLEMENTS_STMT`), and every symbol with a `MAY_CALL` path down to it.
 *     That is the service layer between the two, and a hop whose middle is not
 *     instrumented is the one that comes back RUNTIME_ONLY, because the trace
 *     saw the controller directly over the repository while the source goes
 *     through a helper that had no span.
 *
 * An EXTERNAL symbol is left off: a JDK or library method is not this project's
 * to instrument, and naming one only slows the agent down.
 *
 * Pure, and deterministic: classes sorted, methods sorted inside each class, so
 * the same pack prints the same line every time and a diff of two runs is a
 * diff of the project.
 *
 * @param {import('../core/graph.mjs').Graph} g
 * @returns {{classes:Record<string,string[]>, value:string, classCount:number,
 *            methodCount:number, handlers:number, statementReachers:number}}
 */
export function otelMethodsInclude(g) {
  const isSymbol = (id) => typeof id === 'string' && id.startsWith('symbol:');
  const wanted = new Set();
  const handlers = new Set();

  for (const e of g.edges) {
    if (e.type !== 'HANDLES' || !isSymbol(e.to)) continue;
    handlers.add(e.to);
    wanted.add(e.to);
  }

  // The statement end of every chain, then everything that can call it. The
  // walk is over MAY_CALL IN-edges, which is "who could have run this", and it
  // is bounded by `seen`, so a recursive call cannot loop it.
  const seeds = [];
  for (const e of g.edges) {
    if (e.type === 'IMPLEMENTS_STMT' && isSymbol(e.from)) seeds.push(e.from);
  }
  const reachers = new Set();
  const queue = [...new Set(seeds)];
  const seen = new Set(queue);
  while (queue.length > 0) {
    const id = queue.shift();
    reachers.add(id);
    for (const up of g.inEdges(id)) {
      if (up.type !== 'MAY_CALL' || !isSymbol(up.from) || seen.has(up.from)) continue;
      seen.add(up.from);
      queue.push(up.from);
    }
  }
  for (const id of reachers) wanted.add(id);

  const classes = new Map();
  let methodCount = 0;
  const kept = new Set();
  for (const id of [...wanted].sort()) {
    const node = g.nodes.get(id);
    // A symbol this pack never read is not a symbol to instrument, and an
    // external one is somebody else's code.
    if (!node || node.external === true) continue;
    const member = id.slice('symbol:'.length);
    const hash = member.lastIndexOf('#');
    if (hash <= 0 || hash === member.length - 1) continue;
    const owner = member.slice(0, hash);
    const method = member.slice(hash + 1);
    if (!classes.has(owner)) classes.set(owner, new Set());
    classes.get(owner).add(method);
    kept.add(id);
  }

  const out = {};
  for (const owner of [...classes.keys()].sort()) {
    const methods = [...classes.get(owner)].sort();
    methodCount += methods.length;
    out[owner] = methods;
  }
  const value = Object.entries(out).map(([owner, methods]) => `${owner}[${methods.join(',')}]`).join(';');
  return {
    classes: out,
    value,
    classCount: Object.keys(out).length,
    methodCount,
    handlers: [...handlers].filter((id) => kept.has(id)).length,
    statementReachers: [...reachers].filter((id) => kept.has(id)).length,
  };
}

export class RuntimeBridgeError extends Error {
  constructor(message) { super(message); this.name = 'RuntimeBridgeError'; }
}
