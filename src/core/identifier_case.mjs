// identifier_case.mjs — SQL identifier identity, the graph side (SPEC §8.1, §12).
//
// The MIRROR of `adapters/sql/identifier_case.py`. The Python worker decides
// which catalog table a statement's `FROM ITEM` means; this module decides which
// node id a table or column fact lands on. If the two disagreed, a graph built
// by the bridge and a graph built from the worker's own output would carry
// different tables under the same name, so the fold table and the fold function
// are duplicated ON PURPOSE and cross-checked by
// `test/identifier_case.test.mjs`, which runs both implementations over the same
// inputs and compares the results.
//
// WHAT THE RULE IS AND WHY, per dialect — the citations live in the Python
// module's docstring, which is the long form of this table:
//
//   mysql / mariadb  fold-lower   column names are always compared case-
//                                 insensitively; table-name sensitivity is the
//                                 server's `lower_case_table_names`, and lower
//                                 is the portable setting MySQL's manual
//                                 recommends. A schema that really declares two
//                                 tables differing only in case is reported as a
//                                 collision, never merged in silence.
//   postgres         fold-lower   unquoted identifiers fold to lower case
//   oracle           fold-upper   unquoted identifiers fold to UPPER case
//   hsqldb / h2      fold-upper   SQL-standard folding to UPPER case
//   anything else    exact        fail closed: a fold we cannot cite is a guess
//
// The fold produces a MATCHING KEY only. No user-visible name is ever rewritten:
// a table declared `pms_product` is displayed `pms_product` under every rule.
// Folding is ASCII A-Z only, so Python and JavaScript cannot drift on a locale
// rule (the Turkish dotless i); a non-ASCII identifier is matched exactly.

/** The three identity rules. Mirrored in adapters/sql/identifier_case.py. */
export const IDENTIFIER_CASES = Object.freeze(['fold-lower', 'fold-upper', 'exact']);

/** The rule assumed for a dialect the table below does not name. */
export const DEFAULT_IDENTIFIER_CASE = 'exact';

/**
 * dialect name -> identity rule. Keyed by the names a profile may write AND by
 * the sqlglot dialect names those map onto, so either side can ask. `''` is
 * sqlglot's default (ANSI) parser — no dialect identity, so no fold.
 */
export const DIALECT_IDENTIFIER_CASE = Object.freeze({
  mysql: 'fold-lower',
  mariadb: 'fold-lower',
  postgres: 'fold-lower',
  postgresql: 'fold-lower',
  oracle: 'fold-upper',
  'oracle-11g': 'fold-upper',
  'oracle-19c': 'fold-upper',
  hsqldb: 'fold-upper',
  h2: 'fold-upper',
  '': 'exact',
});

/**
 * The declared identity rule for a dialect name (`exact` when it is unknown).
 * @param {string|null|undefined} dialect
 * @returns {'fold-lower'|'fold-upper'|'exact'}
 */
export function identifierCaseForDialect(dialect) {
  if (dialect == null) return DEFAULT_IDENTIFIER_CASE;
  return Object.hasOwn(DIALECT_IDENTIFIER_CASE, dialect)
    ? DIALECT_IDENTIFIER_CASE[dialect]
    : DEFAULT_IDENTIFIER_CASE;
}

/**
 * The MATCHING KEY for one identifier spelling. ASCII A-Z only (see the header).
 * `null`/`undefined` pass straight through so an absent schema needs no guard.
 * @param {string|null|undefined} name
 * @param {string} identifierCase
 * @returns {string|null|undefined}
 */
export function foldIdentifier(name, identifierCase) {
  if (!IDENTIFIER_CASES.includes(identifierCase)) {
    throw new IdentifierCaseError(
      `unknown identifier case ${JSON.stringify(identifierCase)}. Expected one of ${IDENTIFIER_CASES.join(', ')}`,
    );
  }
  if (name == null || identifierCase === 'exact' || typeof name !== 'string') return name;
  return identifierCase === 'fold-lower'
    ? name.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32))
    : name.replace(/[a-z]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 32));
}

export class IdentifierCaseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IdentifierCaseError';
  }
}
