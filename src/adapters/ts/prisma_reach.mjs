// prisma_reach.mjs — the tables and columns one Prisma call reaches: its own model's, and each relation's it follows.
//
// A RELATION A CALL FOLLOWS IS PART OF THAT CALL'S STATEMENT, not a statement of
// its own. Which SQL Prisma sends for it is settled by things the call site
// does not settle: one query with a join under relationLoadStrategy "join"
// (the relationJoins preview feature), one more query per relation level under
// "query" (the default without it), several statements in one transaction for
// a nested write. What all of those share is the call site, and the call site
// is what a method implements, so it stays the one statement; every edge a
// relation gave names it in `evidence.relation`, so a reader can tell it from
// what the call's own model gave.
//
// Following a relation reads the columns the join matches on, on both sides
// (Prisma selects the parent's key to fetch the related rows by it, or joins on
// it), and the implicit many-to-many table's A and B. A write that sets or
// clears the link writes the columns that hold it, on whichever side they sit,
// or inserts (sets) or deletes (clears) rows of the implicit table; a link that
// is replaced (`set`) is cleared, then set. What a relation reads, writes or
// may read of its own model is what the rule read. A relation only a run-time
// value decides (`may`) caps every edge it gives at SOUND_SET.
//
// A relation filtered on null only checks the link. Where the link sits in the
// model's own table (the foreign key is on this side), Prisma's engine tests
// those columns for NULL and reads nothing of the other table; where it sits in
// the other table, it joins or subselects that table, which is followed as any
// filter is (prisma-engines, query-builders/sql-query-builder/src/filter/
// visitor.rs, visit_one_relation_is_null_filter). A nested write the rule
// marked idle gives what the first entry that applies to this relation leaves:
// nothing (`drops: all`), or the lookup of the rows alone (`drops: writes`).
//
// A LOOKUP is the SELECT Prisma sends before a nested write changes rows it has
// to find first: the related table read, its key, the join's columns, and on a
// many-to-many the implicit table. A write finds the rows its value names
// (`named`: a connect's), or the rows linked to the one it hangs from
// (`linked`: a delete's, through the implicit table on a many-to-many); there
// are none linked to a row the call is creating, so no linked lookup is sent
// under a create. Which operations send one on which kind of relation is the
// pack's (`lookup`, measured on Prisma 6.19.0: a create on the
// list side sends an INSERT alone, a delete there first selects the rows).
//
// ONE EDGE PER TABLE AND ACCESS, as the SQL lane gives one per table and access
// a statement has (adapters/sql/lineage.py): a call that reads a table and
// writes it keeps both, each at the strongest grade any path gave that access,
// so a search for who writes the table never loses it. One edge per column and
// type, at the strongest grade.

const RANK = Object.freeze({ UNRESOLVED: 0, RUNTIME_ONLY: 1, HEURISTIC: 2, SOUND_SET: 3, EXACT: 4 });
const ACCESS_RANK = Object.freeze({ read: 0, delete: 1, write: 2 });
const ACCESS = Object.freeze({ select: 'read', insert: 'write', update: 'write', upsert: 'write', delete: 'delete' });
const weakest = (a, b) => (RANK[a] <= RANK[b] ? a : b);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** One statement's edges, one per table and access and one per column and type, each at the strongest grade any path gave it. */
function collector() {
  const tables = new Map();
  const columns = new Map();
  return {
    table(tid, access, grade, evidence) {
      const prev = tables.get(`${tid}|${access}`);
      if (!prev || RANK[grade] > RANK[prev.grade]) tables.set(`${tid}|${access}`, { tid, access, grade, evidence: { access, ...evidence } });
    },
    column(type, cid, grade, evidence) {
      const prev = columns.get(`${type}|${cid}`);
      if (!prev || RANK[grade] > RANK[prev.grade]) columns.set(`${type}|${cid}`, { type, cid, grade, evidence });
    },
    emit(g, sid) {
      const order = (a, b) => cmp(a.tid, b.tid) || ACCESS_RANK[a.access] - ACCESS_RANK[b.access];
      for (const t of [...tables.values()].sort(order)) g.addEdge({ from: sid, to: t.tid, type: 'EXECUTES', grade: t.grade, evidence: t.evidence });
      for (const [, c] of [...columns].sort(([a], [b]) => cmp(a, b))) g.addEdge({ from: sid, to: c.cid, type: c.type, grade: c.grade, evidence: c.evidence });
    },
  };
}

/** What a call reads, writes and may read of one model, as its columns. */
function modelColumns(c, catalog, model, fx, grade, evidence) {
  const col = (field) => catalog.columnId(model, field);
  const reads = new Set([...fx.reads].map(col).filter(Boolean));
  if (fx.wholeRow) for (const cid of catalog.scalarColumnIds(model)) reads.add(cid);
  for (const cid of reads) c.column('READS', cid, grade, evidence);
  for (const cid of [...fx.writes].map(col).filter(Boolean)) c.column('WRITES', cid, grade, evidence);
  for (const cid of [...fx.mayReads].map(col).filter(Boolean)) c.column('READS', cid, weakest(grade, 'SOUND_SET'), evidence);
}

/** The relations a rule could not follow at one level of the call, said. */
const notFollowed = (model, fx) => [...fx.relations].map((r) => ({ reason: 'relation-not-followed', detail: `${model.name}.${r} reaches another table this statement does not name` }));

/** What each link a nested write names does to it, in order: `replace` clears it, then sets it. */
const LINK_STEPS = Object.freeze({ set: ['set'], clear: ['clear'], replace: ['clear', 'set'] });

/** The link a nested write sets or clears: the columns that hold it (set, or cleared to NULL), or the implicit table's rows (inserted, or deleted). */
function linkEdges(c, rel, f, grade, evidence) {
  const steps = LINK_STEPS[f.link] ?? [];
  if (rel.joinTable && steps.length === 0) c.table(rel.joinTable, 'read', grade, evidence);
  for (const step of steps) {
    if (rel.joinTable && step === 'clear') { c.table(rel.joinTable, 'delete', grade, evidence); continue; }
    for (const cid of rel.link.columns) c.column('WRITES', cid, grade, evidence);
    c.table(rel.link.table, 'write', grade, evidence);
  }
}

/** Which relations an `idle` entry applies on. */
const IDLE_ON = Object.freeze({ any: () => true, 'one-to-one': (rel) => rel.oneToOne === true, 'many-to-many': (rel) => Boolean(rel.joinTable) });

/** What the first `idle` entry that applies to this relation drops (`all`, `writes`), or null when none does. */
const idleDrops = (f, rel) => (f.idle ?? []).find((e) => IDLE_ON[e.on]?.(rel))?.drops ?? null;

/** A null check on a relation whose link sits in the model's own table: those columns are read, and nothing of the other table. True when it was one. */
function localNullCheck(c, rel, f, grade, evidence) {
  if (!f.nullCheck || !rel.inline) return false;
  for (const cid of rel.link.columns) c.column('READS', cid, grade, evidence);
  return true;
}

/** Every relation one level of the call follows, into the model it reaches, and on from there. */
function followAll(c, a, parent, fx, grade, unresolved) {
  unresolved.push(...notFollowed(parent, fx));
  for (const f of fx.follow) {
    const name = `${parent.name}.${f.relation}`;
    const rel = a.catalog.relation(parent, f.relation);
    if (!rel || !rel.ok) {
      unresolved.push({ reason: 'relation-not-followed', detail: `${name} reaches another table this statement does not name: ${rel ? rel.why : 'schema.prisma does not declare it'}` });
      continue;
    }
    const drops = idleDrops(f, rel);
    if (drops !== 'all') followOne(c, a, { name, rel, f, lookupOnly: drops === 'writes' }, f.may ? weakest(grade, 'SOUND_SET') : grade, unresolved);
  }
}

/** One relation the call follows, into the model it reaches: its table, the join, the link, what the call reads there, and on from there. */
function followOne(c, a, { name, rel, f, lookupOnly }, g, unresolved) {
  const evidence = { via: 'prisma', operation: a.operation, relation: name };
  if (localNullCheck(c, rel, f, g, evidence)) return;
  if (!lookupOnly) c.table(rel.targetTable, f.access, g, evidence);
  for (const cid of rel.joinReads) c.column('READS', cid, g, evidence);
  if (!lookupOnly) linkEdges(c, rel, f, g, evidence);
  lookupEdges(c, rel, lookupOf(f, rel, lookupOnly), g, evidence);
  modelColumns(c, a.catalog, rel.target, f.fx, g, evidence);
  followAll(c, a, rel.target, f.fx, g, unresolved);
}

/**
 * The kind of a relation as the pack's `lookup` lists name it, from the side it
 * is followed from; null when the schema does not say whether it is one-to-one.
 */
function relationKind(rel) {
  if (rel.joinTable) return 'many-to-many';
  if (typeof rel.oneToOne !== 'boolean') return null;
  if (rel.inline) return rel.oneToOne ? 'one-to-one-here' : 'one-to-many-one';
  return rel.oneToOne ? 'one-to-one-there' : 'one-to-many-list';
}

/**
 * The lookup a nested write sends on this relation: `{named, linked}`, whether
 * it finds the rows its value names, and the rows linked to the one it hangs
 * from (none are, under a create). A write left with its lookup alone (`drops:
 * writes`) finds the linked rows.
 */
function lookupOf(f, rel, lookupOnly) {
  const kind = relationKind(rel);
  const linked = (lookupOnly || (f.lookup?.linked ?? []).includes(kind)) && f.parentRows !== 'new';
  return { named: (f.lookup?.named ?? []).includes(kind), linked };
}

/** The SELECT a nested write sends to find the related rows: their table and key, and the implicit table when it finds the linked ones on a many-to-many. */
function lookupEdges(c, rel, { named, linked }, g, evidence) {
  if (!named && !linked) return;
  c.table(rel.targetTable, 'read', g, evidence);
  if (rel.joinTable && linked) c.table(rel.joinTable, 'read', g, evidence);
  for (const cid of rel.targetKey) c.column('READS', cid, g, evidence);
}

/**
 * What a call does to its own model's table. An update writes the row only
 * when its data sets a field of it: one whose data holds relation writes alone
 * (`{ posts: { connect: [...] } }`) finds the row, then writes the other
 * tables, and sends no UPDATE of this one (measured on Prisma 6.19 with
 * SQLite). A link held in this table, which such a write may set, is written
 * where the relation is followed. Data not written out may set a field or not:
 * the write is a candidate.
 */
function ownAccess(fx) {
  if (fx.statement !== 'update' || fx.writes.size > 0) return { access: ACCESS[fx.statement], sure: true };
  const unknown = fx.runtimeOnly.has('write') || fx.runtimeOnly.has('arguments');
  return unknown ? { access: 'write', sure: false } : { access: 'read', sure: true };
}

/**
 * The EXECUTES, READS and WRITES edges of one statement, its own model's and
 * every relation's it follows, and what it could not follow.
 *
 * @param {import('../../core/graph.mjs').Graph} g
 * @param {string} sid  the statement's node id
 * @param {{fx:object, model:object, grade:string, operation:string, catalog:object}} a
 *        the rule's reading of the call, the model its delegate names, the
 *        grade its client caps it at, and schema.prisma's catalog
 * @returns {object[]} the `relation-not-followed` entries for the statement's `unresolved`
 */
export function statementEdges(g, sid, a) {
  const c = collector();
  const unresolved = [];
  const evidence = { via: 'prisma', operation: a.operation };
  const own = ownAccess(a.fx);
  c.table(a.catalog.tableId(a.model), own.access, own.sure ? a.grade : weakest(a.grade, 'SOUND_SET'), evidence);
  modelColumns(c, a.catalog, a.model, a.fx, a.grade, evidence);
  followAll(c, a, a.model, a.fx, a.grade, unresolved);
  c.emit(g, sid);
  return unresolved.sort((x, y) => cmp(x.detail, y.detail));
}

export { ACCESS };
