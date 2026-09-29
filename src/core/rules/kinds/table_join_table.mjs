// table_join_table.mjs — the `table.join-table` rule kind: which tables a framework made only to join two others, read from their names and columns.
//
// Some frameworks keep a many-to-many relation in a table they name by their
// own convention, and the project never writes that table: Prisma's implicit
// relation table is `_` and the relation's name (`_OrderToTag`), with the two
// columns `A` and `B`. Such a table holds only the links between the rows of
// the tables it joins, so a map that groups tables by the words of their names
// should put it with those tables, not in a family of its own name. This kind
// knows HOW such a table is recognised: its name starts with the prefix, and,
// when the rule lists columns, its columns are exactly those. The rule packs
// say WHICH prefix and columns (src/core/rules/packs/).
//
// It only classifies. Which tables a join table joins is the graph's (its
// JOINS edges), and where it then goes is the summary's family rule
// (src/core/summary.mjs); neither is guessed from the name here.

const unknownKeys = (obj, allowed) => Object.keys(obj).filter((k) => !allowed.includes(k));
/** Text a name can start with: something, and no space in it. */
const isPrefix = (s) => typeof s === 'string' && s !== '' && !/\s/.test(s);
const isName = (s) => typeof s === 'string' && s.trim() !== '';

function columnErrors(columns) {
  if (columns === undefined) return [];
  if (!Array.isArray(columns) || columns.length === 0) return ['params.columns must be a non-empty list of column names when it is given'];
  const errors = [];
  const seen = new Set();
  for (const c of columns) {
    if (!isName(c)) errors.push(`params.columns has ${JSON.stringify(c)}, which is not a column name`);
    else if (seen.has(c)) errors.push(`params.columns lists ${JSON.stringify(c)} twice`);
    seen.add(c);
  }
  return errors;
}

/** What is wrong with a rule's params, as sentences; empty when nothing is. */
function validateParams(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return ['params must be an object'];
  const errors = unknownKeys(params, ['prefix', 'columns']).map((k) => `params has an unknown key "${k}"`);
  if (!isPrefix(params.prefix)) errors.push('params.prefix must be the text a name starts with: one or more characters, no space');
  return [...errors, ...columnErrors(params.columns)];
}

/** What is wrong with one example; empty when nothing is. */
function validateExample(example) {
  if (!example || typeof example !== 'object' || Array.isArray(example)) return ['an example must be an object'];
  const errors = unknownKeys(example, ['table', 'columns', 'expect', 'why']).map((k) => `an example has an unknown key "${k}"`);
  if (!isName(example.table)) errors.push('an example needs a table name');
  if (!Array.isArray(example.columns) || !example.columns.every(isName)) errors.push('an example\'s columns must be a list of column names, empty when the table has none');
  if (typeof example.expect !== 'boolean') errors.push('an example\'s expect must be true or false');
  if (example.why !== undefined && typeof example.why !== 'string') errors.push('an example\'s why must be text');
  return errors;
}

/**
 * The rule, ready to read tables: a function from a table's bare name and its
 * column names to whether the rule names it a join table.
 */
function compile(rule) {
  const { prefix, columns } = rule.params;
  const want = columns ? [...columns].sort() : null;
  return ({ name, columns: have }) => {
    if (typeof name !== 'string' || !name.startsWith(prefix)) return false;
    if (!want) return true;
    const got = [...(have ?? [])].sort();
    return got.length === want.length && got.every((c, i) => c === want[i]);
  };
}

/** One example against the compiled rule: whether it holds, and what the rule said. */
function runExample(isJoinTable, example) {
  const got = isJoinTable({ name: example.table, columns: example.columns });
  return { passed: got === example.expect, got };
}

export const tableJoinTable = Object.freeze({
  name: 'table.join-table',
  // It reads table and column names, the SQL axis of the graph, whichever lane declared them.
  lane: 'sql',
  // Read when the summary groups the tables it reached into families, not while analyzing.
  stage: 'summary',
  // A classification of a table, not an edge: there is no grade to cap.
  gradeCap: null,
  validateParams,
  validateExample,
  compile,
  runExample,
});
