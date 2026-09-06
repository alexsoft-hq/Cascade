// derived_query.mjs — Spring Data's DERIVED QUERY method names, read as a grammar
// (SPEC §15 M10, §3.4). Pure: a string in, a structure out. Nothing here knows
// what an entity is; resolving a property path against a real entity model is
// `resolvePropertyPath`, which takes an injected lookup, and attaching columns to
// it is src/adapters/jpa_bridge.mjs.
//
// WHY A GRAMMAR AND NOT A REGEX PER CASE: `findByLastNameStartingWith` is not a
// name the engine may guess at. Spring Data documents exactly one derivation —
// subject, then `By`, then predicate parts joined by `And`/`Or`, each a property
// path with an optional operator and an optional `IgnoreCase`, then an optional
// `OrderBy`. Reading it that way means an unreadable name comes back as
// `ok:false` WITH A REASON, and the bridge keeps the statement with an
// `unresolved` diagnostic instead of inventing a column list (§3.3: no silent
// loss, and no silently invented facts either).

/** The introducing keywords, longest first so `findAll` never matches `find` + junk. */
export const SUBJECTS = Object.freeze(['find', 'read', 'get', 'query', 'search', 'stream', 'count', 'exists', 'delete', 'remove']);

/** Subject -> the access a statement built from it performs. */
const SUBJECT_ACCESS = Object.freeze({
  find: 'select', read: 'select', get: 'select', query: 'select', search: 'select', stream: 'select',
  count: 'select', exists: 'select',
  delete: 'delete', remove: 'delete',
});

/**
 * The predicate operators, LONGEST FIRST — the suffix match must prefer
 * `GreaterThanEqual` over `GreaterThan`, and `IsNotNull` over `Null`.
 */
export const OPERATORS = Object.freeze([
  'GreaterThanEqual', 'LessThanEqual', 'GreaterThan', 'LessThan',
  'IsNotNull', 'NotNull', 'IsNull', 'Null',
  'StartingWith', 'EndingWith', 'Containing', 'NotLike', 'Like',
  'Between', 'Equals', 'After', 'Before', 'True', 'False',
  'NotIn', 'In', 'Not', 'Is',
]);

/** Operators that take no bound parameter (they read the column all the same). */
const NO_ARG_OPERATORS = new Set(['IsNotNull', 'NotNull', 'IsNull', 'Null', 'True', 'False']);

/**
 * Parse a Spring Data repository method name.
 *
 * @param {string} methodName
 * @returns {{ok:boolean, reason?:string, subject?:string, access?:string,
 *            distinct?:boolean, limit?:(number|null), hasBy?:boolean,
 *            parts?:{property:string, operator:(string|null), ignoreCase:boolean, connector:(string|null)}[],
 *            orderBy?:{property:string, direction:string}[]}}
 */
export function parseDerivedQuery(methodName) {
  if (typeof methodName !== 'string' || methodName.length === 0) {
    return { ok: false, reason: 'the method name is empty' };
  }

  // ---- subject ------------------------------------------------------------
  let subject = null;
  for (const s of SUBJECTS) {
    if (!methodName.startsWith(s)) continue;
    const next = methodName.charAt(s.length);
    // `find`, `findAll`, `findBy…` are subjects; `finder…` is not one of ours.
    if (next === '' || /[A-Z_]/.test(next)) { subject = s; break; }
  }
  if (!subject) {
    return { ok: false, reason: `no Spring Data subject keyword (${SUBJECTS.join('|')}) introduces ${JSON.stringify(methodName)}` };
  }
  let rest = methodName.slice(subject.length);

  // ---- Distinct / First<n> / Top<n> ---------------------------------------
  let distinct = false;
  if (rest.startsWith('Distinct')) { distinct = true; rest = rest.slice('Distinct'.length); }
  let limit = null;
  const lim = /^(First|Top)(\d*)/.exec(rest);
  if (lim) {
    limit = lim[2] === '' ? 1 : Number(lim[2]);
    rest = rest.slice(lim[0].length);
  }
  if (!distinct && rest.startsWith('Distinct')) { distinct = true; rest = rest.slice('Distinct'.length); }

  // ---- OrderBy … (taken off the END first, so `By` below cannot eat it) ----
  let orderBy = [];
  const orderAt = lastIndexOfRe(rest, /OrderBy(?=[A-Z])/g);
  if (orderAt >= 0) {
    const tail = rest.slice(orderAt + 'OrderBy'.length);
    rest = rest.slice(0, orderAt);
    if (tail.length === 0) return { ok: false, reason: 'OrderBy names no property' };
    orderBy = parseOrderBy(tail);
    for (const o of orderBy) {
      if (!o.property) return { ok: false, reason: 'OrderBy names no property' };
    }
  }

  // ---- the By split -------------------------------------------------------
  const byAt = firstIndexOfRe(rest, /By(?=[A-Z]|$)/g);
  const hasBy = byAt >= 0;
  const predicate = hasBy ? rest.slice(byAt + 2) : '';

  const parts = [];
  if (predicate.length > 0) {
    const chunks = splitConnectors(predicate);
    if (chunks === null) return { ok: false, reason: `the predicate ${JSON.stringify(predicate)} has a dangling And/Or` };
    for (const chunk of chunks) {
      if (chunk.text.length === 0) {
        return { ok: false, reason: `the predicate ${JSON.stringify(predicate)} has an empty part` };
      }
      const part = parsePart(chunk.text);
      if (!part) return { ok: false, reason: `the predicate part ${JSON.stringify(chunk.text)} names no property` };
      parts.push({ ...part, connector: chunk.connector });
    }
  }

  return {
    ok: true,
    subject,
    access: SUBJECT_ACCESS[subject],
    distinct,
    limit,
    hasBy,
    parts,
    orderBy,
  };
}

/** One predicate part: `LastNameStartingWithIgnoreCase` -> property + operator. */
function parsePart(text) {
  let s = text;
  let ignoreCase = false;
  for (const suffix of ['AllIgnoringCase', 'AllIgnoreCase', 'IgnoringCase', 'IgnoreCase']) {
    if (s.endsWith(suffix)) { ignoreCase = true; s = s.slice(0, -suffix.length); break; }
  }
  let operator = null;
  for (const op of OPERATORS) {
    if (s.length > op.length && s.endsWith(op)) { operator = op; s = s.slice(0, -op.length); break; }
  }
  if (s.length === 0) return null;
  return { property: decapitalize(s), operator, ignoreCase, bound: !(operator && NO_ARG_OPERATORS.has(operator)) };
}

/** `LastNameDescFirstName` -> [{lastName,desc},{firstName,asc}]. */
function parseOrderBy(text) {
  const out = [];
  let rest = text;
  while (rest.length > 0) {
    const m = /^(.+?)(Asc|Desc)(?=[A-Z]|$)/.exec(rest);
    if (m) {
      out.push({ property: decapitalize(m[1]), direction: m[2].toLowerCase() });
      rest = rest.slice(m[0].length);
    } else {
      out.push({ property: decapitalize(rest), direction: 'asc' });
      rest = '';
    }
  }
  return out;
}

/**
 * Split a predicate on `And`/`Or` at PROPERTY boundaries (an uppercase letter
 * must follow), so `Color`, `Order…` and `Android…` are not torn apart. Returns
 * null when the predicate ends with a dangling connector.
 */
function splitConnectors(predicate) {
  if (/(And|Or)$/.test(predicate)) return null;
  const out = [];
  let connector = null;
  let buf = '';
  let i = 0;
  while (i < predicate.length) {
    const rest = predicate.slice(i);
    const m = /^(And|Or)(?=[A-Z])/.exec(rest);
    if (m) {
      out.push({ text: buf, connector });
      connector = m[1];
      buf = '';
      i += m[1].length;
      continue;
    }
    buf += predicate[i];
    i += 1;
  }
  out.push({ text: buf, connector });
  return out;
}

/**
 * Resolve a property token against an entity model, with nested traversal:
 * `ownerLastName` becomes `owner` (an association) then `lastName` on the target.
 *
 * The split follows Spring Data's documented rule — try the WHOLE token first,
 * then move the split point leftwards along the camel-case boundaries — so a
 * genuine `ownerLastName` attribute always wins over the nested reading.
 * An explicit `_` (`owner_LastName`) is honoured as a hard separator.
 *
 * @param {string} token  camel-cased property token (`ownerLastName`)
 * @param {string} rootKey  the owning entity's key, as `lookup` understands it
 * @param {(entityKey:string, property:string) => ({attribute:object, associationTo?:string}|null)} lookup
 * @returns {{ok:true, path:{entity:string, property:string, attribute:object}[]}|{ok:false, reason:string}}
 */
export function resolvePropertyPath(token, rootKey, lookup) {
  if (typeof token !== 'string' || token.length === 0) return { ok: false, reason: 'empty property path' };
  if (typeof lookup !== 'function') throw new DerivedQueryError('resolvePropertyPath needs a lookup function');

  if (token.includes('_')) {
    const segs = token.split('_').filter((s) => s.length > 0);
    const path = [];
    let owner = rootKey;
    for (let i = 0; i < segs.length; i += 1) {
      const prop = decapitalize(segs[i]);
      const hit = owner == null ? null : lookup(owner, prop);
      if (!hit) return { ok: false, reason: `${owner ?? '?'} has no property ${prop}` };
      path.push({ entity: owner, property: prop, attribute: hit.attribute });
      owner = hit.associationTo ?? null;
      if (owner == null && i < segs.length - 1) {
        return { ok: false, reason: `${prop} is not an association, so ${segs.slice(i + 1).join('.')} cannot be traversed` };
      }
    }
    return { ok: true, path };
  }

  const heads = camelHeads(token);
  for (const head of heads) {
    const prop = decapitalize(head);
    const hit = lookup(rootKey, prop);
    if (!hit) continue;
    const remainder = token.slice(head.length);
    if (remainder.length === 0) {
      return { ok: true, path: [{ entity: rootKey, property: prop, attribute: hit.attribute }] };
    }
    if (!hit.associationTo) continue; // a leaf cannot carry a nested path
    const deeper = resolvePropertyPath(decapitalize(remainder), hit.associationTo, lookup);
    if (deeper.ok) {
      return { ok: true, path: [{ entity: rootKey, property: prop, attribute: hit.attribute }, ...deeper.path] };
    }
  }
  return { ok: false, reason: `${rootKey} has no property path ${token}` };
}

/**
 * Every camel-case prefix of a token, LONGEST FIRST:
 * `ownerLastName` -> ['ownerLastName', 'ownerLast', 'owner'].
 */
export function camelHeads(token) {
  const bounds = [token.length];
  for (let i = token.length - 1; i > 0; i -= 1) {
    if (/[A-Z]/.test(token[i])) bounds.push(i);
  }
  return bounds.map((n) => token.slice(0, n)).filter((s) => s.length > 0);
}

function decapitalize(s) {
  if (typeof s !== 'string' || s.length === 0) return s;
  // `URL` stays `URL`; `LastName` becomes `lastName` (JavaBeans).
  if (s.length > 1 && s[0] === s[0].toUpperCase() && s[1] === s[1].toUpperCase()) return s;
  return s[0].toLowerCase() + s.slice(1);
}

function firstIndexOfRe(s, re) {
  re.lastIndex = 0;
  const m = re.exec(s);
  return m ? m.index : -1;
}

function lastIndexOfRe(s, re) {
  re.lastIndex = 0;
  let last = -1;
  let m;
  while ((m = re.exec(s)) !== null) {
    last = m.index;
    re.lastIndex = m.index + 1;
  }
  return last;
}

export class DerivedQueryError extends Error {
  constructor(message) { super(message); this.name = 'DerivedQueryError'; }
}
