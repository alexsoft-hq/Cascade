// typeorm_builder_read.mjs — what the text of a query builder step names: `alias.property` paths and bare names, each placed on a column or said.
//
// TypeORM replaces `alias.property` in a condition with the column the
// metadata maps (a relation that owns a join column stands for that column),
// and passes anything else to the database as written. So a path is read
// against the entity its alias stands for: a property, a relation's join
// column, or a column by its own name. A bare name is a column only where one
// table of the query has a column by that name. A quoted string, a parameter
// (`:email`, `:...ids`), an SQL word the pack lists and a function name are not
// columns. Anything left is said, never guessed.

/** The paths and bare names a text names. */
export function namesInText(text, sqlWords) {
  const clean = String(text)
    .replace(/'(?:[^'\\]|\\.)*'/g, ' ')
    .replace(/:\.\.\.[A-Za-z_]\w*|:[A-Za-z_]\w*/g, ' ')
    .replace(/["`]/g, '');
  const pathRe = /\b([A-Za-z_]\w*)\.([A-Za-z_]\w*)\b/g;
  const paths = [...clean.matchAll(pathRe)].map((m) => ({ alias: m[1], prop: m[2] }));
  const rest = clean.replace(pathRe, ' ');
  const bare = [...rest.matchAll(/\b([A-Za-z_]\w*)\b(?!\s*\()/g)].map((m) => m[1]).filter((w) => !sqlWords.includes(w.toLowerCase()));
  return { paths, bare };
}

/** The columns a property of an entity view stands for: its column, or a relation's join columns. */
export function columnsOfProperty(view, prop) {
  const own = view.columns.find((c) => c.property === prop && !c.join);
  if (own) return [own.column];
  const joins = view.columns.filter((c) => c.join === prop).map((c) => c.column);
  if (joins.length > 0) return joins;
  return view.columns.some((c) => c.column === prop) ? [prop] : [];
}

/** Every column a text names, on the views its aliases stand for: `{hits: [{view, column}], notRead: [text]}`. */
export function columnsInText(text, aliases, sqlWords) {
  const { paths, bare } = namesInText(text, sqlWords);
  const hits = [];
  const notRead = [];
  for (const p of paths) {
    const view = aliases.get(p.alias);
    const cols = view ? columnsOfProperty(view, p.prop) : [];
    if (cols.length === 0) notRead.push(`${p.alias}.${p.prop}`);
    for (const column of cols) hits.push({ view, column });
  }
  const views = [...new Set(aliases.values())];
  for (const word of bare) {
    const owners = views.filter((v) => v.columns.some((c) => c.column === word));
    if (owners.length === 1) hits.push({ view: owners[0], column: word });
    else notRead.push(word);
  }
  return { hits, notRead };
}
