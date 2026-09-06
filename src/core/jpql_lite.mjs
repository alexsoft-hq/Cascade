// jpql_lite.mjs — a SMALL reader for the JPQL that `@Query` carries (SPEC §15 M10).
//
// It is deliberately not a JPQL parser. It reads the shape the query language
// actually uses in repositories — SELECT/UPDATE/DELETE with a FROM root, joins
// along associations, and identifier references of the form `alias.attr[.attr]` —
// and it hands back WHICH ALIAS READS WHICH PATH. Resolving an alias to an
// entity and a path to a column is the bridge's job (src/adapters/jpa_bridge.mjs),
// which is the only place that knows the entity model.
//
// THE HONESTY RULE (SPEC §3.3): the reader never guesses. Everything it can
// classify comes back as a structured reference; everything it cannot — a
// subquery, an unreadable clause, a join it does not model — comes back in
// `diagnostics`, and the statement is KEPT with those diagnostics rather than
// dropped or silently reported as touching nothing. Identifiers inside a
// construct it could not classify are still collected, because a column read
// inside a function call is still a column read.
//
// Pure: a string in, a plain object out.

/** Clause keywords the reader recognises (upper-cased comparison). */
const CLAUSE_KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'GROUP', 'HAVING', 'ORDER', 'SET', 'UPDATE', 'DELETE',
  'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL', 'CROSS',
]);

/** Words that are never an alias reference. */
const RESERVED = new Set([
  ...CLAUSE_KEYWORDS,
  'AS', 'BY', 'DISTINCT', 'FETCH', 'ON', 'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL', 'LIKE', 'BETWEEN',
  'ASC', 'DESC', 'NEW', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'EXISTS', 'ALL', 'ANY', 'SOME',
  'TRUE', 'FALSE', 'EMPTY', 'MEMBER', 'OF', 'ESCAPE', 'TREAT', 'KEY', 'VALUE', 'ENTRY',
]);

/**
 * Read one JPQL statement.
 *
 * @param {string} text
 * @returns {{ok:boolean, kind:(string|null), roots:{entity:string, alias:string}[],
 *            joins:{base:string, path:string[], alias:(string|null), fetch:boolean, type:string}[],
 *            reads:{alias:string, path:string[]}[],
 *            writes:{alias:string, path:string[]}[],
 *            diagnostics:{reason:string, detail:string}[]}}
 */
export function readJpql(text) {
  const out = {
    ok: false, kind: null, roots: [], joins: [], reads: [], writes: [], diagnostics: [],
  };
  if (typeof text !== 'string' || text.trim().length === 0) {
    out.diagnostics.push({ reason: 'empty-query', detail: 'the @Query annotation carries no text' });
    return out;
  }
  let toks;
  try {
    toks = tokenize(text);
  } catch (e) {
    out.diagnostics.push({ reason: 'tokenize-failed', detail: e.message });
    return out;
  }
  if (toks.length === 0) {
    out.diagnostics.push({ reason: 'empty-query', detail: 'nothing but whitespace' });
    return out;
  }

  const head = up(toks[0].text);
  if (head === 'SELECT') return readSelect(toks, out);
  if (head === 'UPDATE') return readUpdate(toks, out);
  if (head === 'DELETE') return readDelete(toks, out);
  out.diagnostics.push({ reason: 'unknown-statement', detail: `a JPQL statement must start with SELECT, UPDATE or DELETE, not ${JSON.stringify(toks[0].text)}` });
  return out;
}

// ---------------------------------------------------------------------------
// statements
// ---------------------------------------------------------------------------

function readSelect(toks, out) {
  out.kind = 'select';
  const fromAt = indexOfKeyword(toks, 'FROM', 1);
  if (fromAt < 0) {
    out.diagnostics.push({ reason: 'no-from', detail: 'the SELECT names no FROM clause' });
    return out;
  }
  // ---- the select list ---------------------------------------------------
  collectRefs(toks.slice(1, fromAt), out, 'reads');

  // ---- FROM roots + joins ------------------------------------------------
  const bodyEnd = readFromAndJoins(toks, fromAt + 1, out);

  // ---- everything after: WHERE / GROUP BY / HAVING / ORDER BY ------------
  collectRefs(toks.slice(bodyEnd), out, 'reads');
  out.ok = out.roots.length > 0;
  if (!out.ok) out.diagnostics.push({ reason: 'no-from-entity', detail: 'the FROM clause names no entity' });
  return out;
}

function readUpdate(toks, out) {
  out.kind = 'update';
  const setAt = indexOfKeyword(toks, 'SET', 1);
  if (setAt < 0) {
    out.diagnostics.push({ reason: 'no-set', detail: 'the UPDATE names no SET clause' });
    return out;
  }
  readRoot(toks, 1, setAt, out);
  const whereAt = indexOfKeyword(toks, 'WHERE', setAt + 1);
  const setEnd = whereAt < 0 ? toks.length : whereAt;
  readAssignments(toks.slice(setAt + 1, setEnd), out);
  if (whereAt >= 0) collectRefs(toks.slice(whereAt), out, 'reads');
  out.ok = out.roots.length > 0;
  if (!out.ok) out.diagnostics.push({ reason: 'no-from-entity', detail: 'the UPDATE names no entity' });
  return out;
}

function readDelete(toks, out) {
  out.kind = 'delete';
  let i = 1;
  if (i < toks.length && up(toks[i].text) === 'FROM') i += 1;
  const whereAt = indexOfKeyword(toks, 'WHERE', i);
  readRoot(toks, i, whereAt < 0 ? toks.length : whereAt, out);
  if (whereAt >= 0) collectRefs(toks.slice(whereAt), out, 'reads');
  out.ok = out.roots.length > 0;
  if (!out.ok) out.diagnostics.push({ reason: 'no-from-entity', detail: 'the DELETE names no entity' });
  return out;
}

// ---------------------------------------------------------------------------
// clauses
// ---------------------------------------------------------------------------

/** `<Entity> [AS] <alias>` — one root, used by UPDATE and DELETE. */
function readRoot(toks, start, end, out) {
  const slice = toks.slice(start, end);
  if (slice.length === 0) return;
  const entity = simpleName(slice[0].text);
  let alias = entity;
  let k = 1;
  if (k < slice.length && up(slice[k].text) === 'AS') k += 1;
  if (k < slice.length && isIdentifier(slice[k]) && !RESERVED.has(up(slice[k].text))) alias = slice[k].text;
  out.roots.push({ entity, alias });
}

/**
 * The FROM clause and every JOIN after it. Returns the index at which the
 * reader stopped (the first token of WHERE/GROUP/HAVING/ORDER, or the end).
 */
function readFromAndJoins(toks, start, out) {
  let i = start;
  // roots: `Entity a[, Entity b]*`
  for (;;) {
    if (i >= toks.length) return i;
    const t = toks[i];
    if (!isIdentifier(t) || RESERVED.has(up(t.text))) break;
    const entity = simpleName(t.text);
    i += 1;
    let alias = entity;
    if (i < toks.length && up(toks[i].text) === 'AS') i += 1;
    if (i < toks.length && isIdentifier(toks[i]) && !RESERVED.has(up(toks[i].text))) {
      alias = toks[i].text;
      i += 1;
    }
    out.roots.push({ entity, alias });
    if (i < toks.length && toks[i].text === ',') { i += 1; continue; }
    break;
  }

  // joins
  for (;;) {
    if (i >= toks.length) return i;
    const kw = up(toks[i].text);
    if (kw === 'WHERE' || kw === 'GROUP' || kw === 'HAVING' || kw === 'ORDER') return i;
    let type = 'inner';
    if (kw === 'LEFT' || kw === 'RIGHT' || kw === 'FULL' || kw === 'INNER' || kw === 'CROSS') {
      type = kw.toLowerCase();
      i += 1;
      if (i < toks.length && up(toks[i].text) === 'OUTER') i += 1;
    }
    if (i >= toks.length || up(toks[i].text) !== 'JOIN') {
      // Something the reader does not model sits where a JOIN was expected.
      out.diagnostics.push({ reason: 'unreadable-clause', detail: `cannot classify ${JSON.stringify(toks[i].text)} in the FROM clause` });
      collectRefs(toks.slice(i), out, 'reads');
      return toks.length;
    }
    i += 1;
    let fetch = false;
    if (i < toks.length && up(toks[i].text) === 'FETCH') { fetch = true; i += 1; }
    if (i >= toks.length) {
      out.diagnostics.push({ reason: 'unreadable-clause', detail: 'a JOIN names nothing' });
      return i;
    }
    const target = toks[i].text;
    i += 1;
    // The alias is consumed either way, so a join the reader does not model is
    // reported ONCE rather than leaving its alias to look like a broken clause.
    let alias = null;
    if (i < toks.length && up(toks[i].text) === 'AS') i += 1;
    if (i < toks.length && isIdentifier(toks[i]) && !RESERVED.has(up(toks[i].text))) {
      alias = toks[i].text;
      i += 1;
    }
    const segs = target.split('.');
    if (segs.length < 2) {
      // `JOIN Entity e ON …` — a non-association join is not modelled here.
      out.diagnostics.push({ reason: 'join-not-an-association', detail: `JOIN ${target} does not walk an association (alias.path)` });
    } else {
      out.joins.push({ base: segs[0], path: segs.slice(1), alias, fetch, type });
    }
    if (i < toks.length && up(toks[i].text) === 'ON') {
      const stop = nextClause(toks, i + 1);
      collectRefs(toks.slice(i + 1, stop), out, 'reads');
      i = stop;
    }
  }
}

/** `a.x = :v, a.y = a.z + 1` — the left of each top-level `=` is a WRITE. */
function readAssignments(slice, out) {
  let start = 0;
  let depth = 0;
  const segments = [];
  for (let i = 0; i < slice.length; i += 1) {
    const t = slice[i].text;
    if (t === '(') depth += 1;
    else if (t === ')') depth -= 1;
    else if (t === ',' && depth === 0) { segments.push(slice.slice(start, i)); start = i + 1; }
  }
  segments.push(slice.slice(start));
  for (const seg of segments) {
    if (seg.length === 0) continue;
    let eq = -1;
    let depth2 = 0;
    for (let i = 0; i < seg.length; i += 1) {
      if (seg[i].text === '(') depth2 += 1;
      else if (seg[i].text === ')') depth2 -= 1;
      else if (seg[i].text === '=' && depth2 === 0) { eq = i; break; }
    }
    if (eq < 0) {
      out.diagnostics.push({ reason: 'unreadable-assignment', detail: seg.map((t) => t.text).join(' ') });
      collectRefs(seg, out, 'reads');
      continue;
    }
    collectRefs(seg.slice(0, eq), out, 'writes');
    collectRefs(seg.slice(eq + 1), out, 'reads');
  }
}

// ---------------------------------------------------------------------------
// references
// ---------------------------------------------------------------------------

/**
 * Every `alias(.attr)*` reference in a token slice, into `out[bucket]`.
 * A bare identifier (no dot) is a whole-alias reference — `SELECT o FROM Owner o`
 * reads every column of `o`. A constructor expression's class name and a function
 * name are NOT references, and a nested SELECT is reported rather than pretended
 * away.
 */
function collectRefs(slice, out, bucket) {
  for (let i = 0; i < slice.length; i += 1) {
    const t = slice[i];
    if (!isIdentifier(t)) continue;
    const word = up(t.text);
    if (word === 'SELECT') {
      out.diagnostics.push({ reason: 'subquery', detail: 'a nested SELECT is not modelled; identifiers inside it are still collected, and may not resolve' });
      continue;
    }
    if (word === 'NEW') {
      // `new com.example.Dto(...)` — the DTO class is not an entity reference.
      if (i + 1 < slice.length && isIdentifier(slice[i + 1])) i += 1;
      continue;
    }
    if (RESERVED.has(word)) continue;
    // A function call (`COUNT(`, `LOWER(`) is not a reference; its arguments are.
    if (i + 1 < slice.length && slice[i + 1].text === '(') continue;
    const segs = t.text.split('.');
    const alias = segs[0];
    const path = segs.slice(1);
    push(out[bucket], { alias, path });
  }
}

function push(list, ref) {
  if (!list.some((r) => r.alias === ref.alias && r.path.join('.') === ref.path.join('.'))) list.push(ref);
}

// ---------------------------------------------------------------------------
// tokenizer
// ---------------------------------------------------------------------------

/**
 * Tokens: dotted identifiers, numbers, quoted strings, parameters (`?1`, `:name`)
 * and single punctuation characters. Comparison operators come out as their own
 * tokens; `=` is one token, which is all `readAssignments` needs.
 * @param {string} s
 * @returns {{text:string, kind:string}[]}
 */
export function tokenize(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i += 1; continue; }
    if (c === "'") {
      let j = i + 1;
      while (j < s.length) {
        if (s[j] === "'" && s[j + 1] === "'") { j += 2; continue; }
        if (s[j] === "'") break;
        j += 1;
      }
      if (j >= s.length) throw new JpqlError('an unterminated string literal');
      out.push({ text: s.slice(i, j + 1), kind: 'string' });
      i = j + 1;
      continue;
    }
    if (c === ':' || c === '?') {
      const m = /^[:?][A-Za-z0-9_$]*/.exec(s.slice(i));
      out.push({ text: m[0], kind: 'param' });
      i += m[0].length;
      continue;
    }
    if (/[0-9]/.test(c)) {
      const m = /^[0-9]+(\.[0-9]+)?([eE][-+]?[0-9]+)?[LlFfDd]?/.exec(s.slice(i));
      out.push({ text: m[0], kind: 'number' });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const m = /^[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*)*/.exec(s.slice(i));
      out.push({ text: m[0], kind: 'ident' });
      i += m[0].length;
      continue;
    }
    const two = s.slice(i, i + 2);
    if (['<=', '>=', '<>', '!='].includes(two)) { out.push({ text: two, kind: 'op' }); i += 2; continue; }
    out.push({ text: c, kind: 'punct' });
    i += 1;
  }
  return out;
}

function isIdentifier(t) { return t && t.kind === 'ident'; }
function up(s) { return String(s).toUpperCase(); }
function simpleName(s) { const p = String(s).split('.'); return p[p.length - 1]; }

function indexOfKeyword(toks, kw, from) {
  let depth = 0;
  for (let i = from; i < toks.length; i += 1) {
    if (toks[i].text === '(') depth += 1;
    else if (toks[i].text === ')') depth -= 1;
    else if (depth === 0 && up(toks[i].text) === kw) return i;
  }
  return -1;
}

function nextClause(toks, from) {
  let depth = 0;
  for (let i = from; i < toks.length; i += 1) {
    if (toks[i].text === '(') depth += 1;
    else if (toks[i].text === ')') depth -= 1;
    else if (depth === 0) {
      const w = up(toks[i].text);
      if (w === 'WHERE' || w === 'GROUP' || w === 'HAVING' || w === 'ORDER'
        || w === 'JOIN' || w === 'LEFT' || w === 'RIGHT' || w === 'INNER' || w === 'FULL' || w === 'CROSS') return i;
    }
  }
  return toks.length;
}

export class JpqlError extends Error {
  constructor(message) { super(message); this.name = 'JpqlError'; }
}
