// sql_dialect_path.mjs — the `sql.dialect-path` rule kind: which database a file is for, read from a word in its path.
//
// A repository that ships its schema for several databases says which file is
// for which where it is easiest to read: `db/mysql/schema.sql` beside
// `db/postgresql/schema.sql`, or `dolphinscheduler_h2.sql` beside
// `dolphinscheduler_mysql.sql`. This kind knows HOW such a word is read: a
// whole word of the path, lower-cased, never part of a longer word. The rule
// packs say WHICH words name WHICH database (src/core/rules/packs/).
//
// ORDER IS PART OF WHAT A RULE SAYS. The first entry of a rule whose word is in
// the path wins, so a rule lists first the entry it prefers when a path names
// two (a MariaDB directory holding a file with "mysql" in its name is MariaDB's).

/** A word as a path spells it once lower-cased; it goes into a pattern, so nothing else is allowed. */
const WORD = /^[a-z0-9]+$/;
/** A one-letter word would match far too much to mean a database. */
const MIN_WORD_LENGTH = 2;

const isWord = (s) => typeof s === 'string' && s.length >= MIN_WORD_LENGTH && WORD.test(s);
const unknownKeys = (obj, allowed) => Object.keys(obj).filter((k) => !allowed.includes(k));

function entryErrors(entry, i, seen) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [`dialects[${i}] must be an object`];
  const errors = unknownKeys(entry, ['dialect', 'names', 'why']).map((k) => `dialects[${i}] has an unknown key "${k}"`);
  if (!isWord(entry.dialect)) errors.push(`dialects[${i}].dialect must be a lower-case word of two or more letters or digits`);
  if (!Array.isArray(entry.names) || entry.names.length === 0) return [...errors, `dialects[${i}].names must be a non-empty list`];
  for (const name of entry.names) {
    if (!isWord(name)) errors.push(`dialects[${i}].names has "${name}", which is not a lower-case word of two or more letters or digits`);
    else if (seen.has(name)) errors.push(`dialects[${i}].names has "${name}", which dialects[${seen.get(name)}] already names: one word cannot name two databases`);
    else seen.set(name, i);
  }
  if (entry.why !== undefined && typeof entry.why !== 'string') errors.push(`dialects[${i}].why must be text`);
  return errors;
}

/** What is wrong with a rule's params, as sentences; empty when nothing is. */
function validateParams(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return ['params must be an object'];
  const errors = unknownKeys(params, ['dialects']).map((k) => `params has an unknown key "${k}"`);
  if (!Array.isArray(params.dialects) || params.dialects.length === 0) return [...errors, 'params.dialects must be a non-empty list'];
  const seen = new Map();
  return [...errors, ...params.dialects.flatMap((entry, i) => entryErrors(entry, i, seen))];
}

/** What is wrong with one example, given the rule's params; empty when nothing is. */
function validateExample(example, params) {
  if (!example || typeof example !== 'object' || Array.isArray(example)) return ['an example must be an object'];
  const errors = unknownKeys(example, ['path', 'expect', 'why']).map((k) => `an example has an unknown key "${k}"`);
  if (typeof example.path !== 'string' || example.path === '') errors.push('an example needs a path');
  // The params may be the broken ones this report is about: read them without trusting their shape.
  const declared = new Set(Array.isArray(params?.dialects) ? params.dialects.map((d) => d?.dialect) : []);
  if (example.expect !== null && !declared.has(example.expect)) {
    errors.push(`the example for ${JSON.stringify(example.path)} expects ${JSON.stringify(example.expect)}, which is neither null nor a dialect this rule declares`);
  }
  return errors;
}

/**
 * The rule, ready to read paths: a function from a path to the database it
 * names ({dialect, token, at}) or null.
 */
function compile(rule) {
  const entries = rule.params.dialects.flatMap((d) => d.names.map((name) => ({
    dialect: d.dialect, name, re: new RegExp(`(^|[^a-z0-9])${name}([^a-z0-9]|$)`),
  })));
  return (relPath) => {
    const lower = String(relPath ?? '').toLowerCase();
    for (const e of entries) {
      const m = e.re.exec(lower);
      if (m) return { dialect: e.dialect, token: e.name, at: m.index + m[1].length, rule: rule.id };
    }
    return null;
  };
}

/** One example against the compiled rule: whether it holds, and what the rule said. */
function runExample(match, example) {
  const hit = match(example.path);
  const got = hit === null ? null : hit.dialect;
  return { passed: got === example.expect, got };
}

export const sqlDialectPath = Object.freeze({
  name: 'sql.dialect-path',
  lane: 'sql',
  stage: 'discovery',
  // A classification of a file, not an edge: there is no grade to cap.
  gradeCap: null,
  validateParams,
  validateExample,
  compile,
  runExample,
});
