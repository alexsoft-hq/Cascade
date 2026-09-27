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
// or inserts (sets) or deletes (clears) rows of the implicit table. What a
// relation reads, writes or may read of its own model is what the rule read. A
// relation only a run-time value decides (`may`) caps every edge it gives at
// SOUND_SET. One edge per table and per column and type: the strongest grade
// any path gave it, and at that grade the strongest access.

const RANK = Object.freeze({ UNRESOLVED: 0, RUNTIME_ONLY: 1, HEURISTIC: 2, SOUND_SET: 3, EXACT: 4 });
const ACCESS_RANK = Object.freeze({ read: 0, delete: 1, write: 2 });
const ACCESS = Object.freeze({ select: 'read', insert: 'write', update: 'write', upsert: 'write', delete: 'delete' });
const weakest = (a, b) => (RANK[a] <= RANK[b] ? a : b);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** One statement's edges, kept one per target: the strongest grade wins, then the strongest access at that grade. */
function collector() {
  const tables = new Map();
  const columns = new Map();
  return {
    table(tid, access, grade, evidence) {
      const prev = tables.get(tid);
      if (prev && (RANK[grade] < RANK[prev.grade] || (grade === prev.grade && ACCESS_RANK[access] <= ACCESS_RANK[prev.access]))) return;
      tables.set(tid, { access, grade, evidence: { access, ...evidence } });
    },
    column(type, cid, grade, evidence) {
      const prev = columns.get(`${type}|${cid}`);
      if (!prev || RANK[grade] > RANK[prev.grade]) columns.set(`${type}|${cid}`, { type, cid, grade, evidence });
    },
    emit(g, sid) {
      for (const [tid, t] of [...tables].sort(([a], [b]) => cmp(a, b))) g.addEdge({ from: sid, to: tid, type: 'EXECUTES', grade: t.grade, evidence: t.evidence });
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

/** The link a nested write sets or clears: the columns that hold it, or the implicit table's rows. */
function linkEdges(c, rel, f, grade, evidence) {
  if (rel.joinTable) c.table(rel.joinTable, f.link === 'set' ? 'write' : f.link === 'clear' ? 'delete' : 'read', grade, evidence);
  if (!f.link || (rel.joinTable && f.link === 'clear')) return;
  for (const cid of rel.link.columns) c.column('WRITES', cid, grade, evidence);
  c.table(rel.link.table, 'write', grade, evidence);
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
    const g = f.may ? weakest(grade, 'SOUND_SET') : grade;
    const evidence = { via: 'prisma', operation: a.operation, relation: name };
    c.table(rel.targetTable, f.access, g, evidence);
    for (const cid of rel.joinReads) c.column('READS', cid, g, evidence);
    linkEdges(c, rel, f, g, evidence);
    modelColumns(c, a.catalog, rel.target, f.fx, g, evidence);
    followAll(c, a, rel.target, f.fx, g, unresolved);
  }
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
  c.table(a.catalog.tableId(a.model), ACCESS[a.fx.statement], a.grade, evidence);
  modelColumns(c, a.catalog, a.model, a.fx, a.grade, evidence);
  followAll(c, a, a.model, a.fx, a.grade, unresolved);
  c.emit(g, sid);
  return unresolved.sort((x, y) => cmp(x.detail, y.detail));
}

export { ACCESS };
