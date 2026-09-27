// prisma_schema.mjs — the tables and columns a schema.prisma declares, read from its text.
//
// A model is a table: the name its `@@map` gives, else the model's own name. A
// scalar field is a column: the name its `@map` gives, else the field's own name.
// A field whose type is another model is a RELATION, not a column: the columns
// that hold it are the ones its `@relation(fields: [...])` names. A field whose
// type is an enum is a column like any scalar.
//
// `@@unique([a, b], name: "x")` and `@@id([a, b])` also give the model a
// COMPOUND: a client key name (the one Prisma Client's `where` takes) mapped to
// the fields it joins. A name is what `name:` gives; with none, Prisma's own
// default is the fields joined with `_`, so a call site never has to be read by
// splitting a key on `_` again once this is read. `map:` is the database
// constraint's own name and never changes the client name.
//
// `@@schema("x")` names the Postgres/CockroachDB schema a model lives in
// (multi-schema Prisma), read into `model.schema`.
//
// This is Prisma's own mapping, written down in the schema, so a name read here
// is the name Prisma sends. It says nothing about whether the database the
// application connects to has that table: the schema is the declaration, and
// the pack says which file it came from.

const BLOCK_START = /^\s*(model|enum|type|view|datasource|generator)\s+(\w+)\s*\{\s*$/;
const FIELD = /^\s*(\w+)\s+(\w+)(\[\])?(\?)?(.*)$/;

const stripComment = (line) => {
  const i = line.indexOf('//');
  return i < 0 ? line : line.slice(0, i);
};

/** The string argument of `@map("x")` / `@@map("x")` in an attribute text, or null. */
function mapName(text, attr) {
  const m = new RegExp(`${attr}\\(\\s*(?:name\\s*:\\s*)?"([^"]*)"`).exec(text);
  return m ? m[1] : null;
}

/** The field list of `@relation(fields: [a, b], ...)`, or []. */
function relationFields(text) {
  const m = /@relation\([^)]*fields\s*:\s*\[([^\]]*)\]/.exec(text);
  return m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
}

/** The field list of `[a, b]`, written bare or as `fields: [a, b]`. */
function fieldListOf(body) {
  const m = /fields\s*:\s*\[([^\]]*)\]/.exec(body) ?? /^\s*\[([^\]]*)\]/.exec(body);
  return m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
}

/**
 * The client key `@@unique(...)` or `@@id(...)` gives: `name:` if the block
 * writes one, else the fields joined with `_`, Prisma's own default. `map:`,
 * the database constraint's name, plays no part in this and is not read here.
 */
function compoundOf(line) {
  const m = /@@(?:unique|id)\(([^)]*)\)/.exec(line);
  if (!m) return null;
  const fields = fieldListOf(m[1]);
  if (fields.length === 0) return null;
  const named = /name\s*:\s*"([^"]*)"/.exec(m[1]);
  return { name: named ? named[1] : fields.join('_'), fields };
}

/** `@@map`, `@@schema`, and a compound key (`@@unique`, `@@id`), each read off one block-level attribute line. */
function readModelAttr(model, line) {
  model.table = mapName(line, '@@map') ?? model.table;
  model.schema = mapName(line, '@@schema') ?? model.schema;
  const compound = compoundOf(line);
  if (compound) model.compounds[compound.name] = compound.fields;
}

function readBlocks(text) {
  const blocks = [];
  let cur = null;
  for (const raw of text.split('\n')) {
    const line = stripComment(raw);
    if (cur === null) {
      const m = BLOCK_START.exec(line);
      if (m) cur = { kind: m[1], name: m[2], lines: [] };
      continue;
    }
    if (/^\s*\}\s*$/.test(line)) { blocks.push(cur); cur = null; continue; }
    if (line.trim() !== '') cur.lines.push(line);
  }
  return blocks;
}

function readModel(block, typeKinds) {
  const model = { name: block.name, table: block.name, fields: [], compounds: {}, schema: null, block: block.kind };
  for (const line of block.lines) {
    if (/^\s*@@/.test(line)) { readModelAttr(model, line); continue; }
    const m = FIELD.exec(line);
    if (!m) continue;
    const [, name, type, list, optional, attrs] = m;
    const relation = typeKinds.get(type) === 'model';
    model.fields.push({
      name, type, list: Boolean(list), optional: Boolean(optional),
      relation, column: relation ? null : mapName(attrs, '@map') ?? name,
      id: /@id\b/.test(attrs), relationFields: relation ? relationFields(attrs) : [],
    });
  }
  return model;
}

/**
 * The models of one schema text, by name, with the provider its datasource
 * names.
 *
 * @returns {{provider:(string|null), models:Map<string,{name:string, table:string, schema:(string|null), compounds:object, fields:object[]}>}}
 */
export function readPrismaSchema(text) {
  const blocks = readBlocks(String(text ?? ''));
  const typeKinds = new Map(blocks.map((b) => [b.name, b.kind]));
  const models = new Map();
  for (const b of blocks) if (b.kind === 'model' || b.kind === 'view') models.set(b.name, readModel(b, typeKinds));
  const ds = blocks.find((b) => b.kind === 'datasource');
  const provider = ds ? (ds.lines.map((l) => /provider\s*=\s*"([^"]+)"/.exec(l)).find(Boolean) ?? [null, null])[1] : null;
  return { provider, models };
}

/** The model a client delegate names: `prisma.marketData` is `MarketData`. */
export function modelOfDelegate(models, delegate) {
  if (typeof delegate !== 'string' || delegate === '') return null;
  for (const m of models.values()) if (m.name.charAt(0).toLowerCase() + m.name.slice(1) === delegate) return m;
  return null;
}
