// typeorm_builder.mjs — the steps of one query builder, gathered from where the source writes them.
//
// `const qb = getRepository(Article).createQueryBuilder('article').leftJoin(...)`
// then `if (tag) qb.andWhere('article.tagList LIKE :tag')` and `qb.getMany()`:
// one builder, whose steps are the calls chained where it is made and every
// call written later on the local that holds it (by where that local is
// declared, so another local spelled `qb` is another builder). A step
// written under a condition, in a loop or in a callback is marked, and what it
// reads MAY be read. A chain stops at the step that runs the query: what is
// called on the rows it returns is not the builder's; and at `clone`, whose
// steps build another builder, which is not read here.
//
// A builder is read as not going anywhere else only where every use of its
// local is one this reading recognizes: a call on it whose value is thrown
// away, or ends in a step that runs the query or makes another builder. The
// worker records every other use (adapters/ts/tsuses.mjs): handed to a call or
// a `new`, put in an object or a list, a branch of a condition, held in
// another local by a step that returns the builder (`const q2 = qb.where()`),
// returned. Such a builder may be given steps this reading does not see, a
// select that narrows the rows or a where that replaces the filter: what it
// reads is then a candidate set that may be short, and it is said
// (`escaped`).

const strArg = (v) => (v && v.k === 'str' ? v.v : null);
/** The steps whose value is no longer the builder: one that runs the query, and one that makes another builder. */
const ENDS = new Set(['rows', 'count', 'clone']);

/** Steps up to and with the first that runs the query, or up to one that makes another builder (clone, subQuery); `ran` says whether one ran it. */
function upToTerminal(steps, roleOf) {
  const i = steps.findIndex((s) => ENDS.has(roleOf(s.name)));
  if (i < 0) return { steps, ran: false };
  return roleOf(steps[i].name) === 'clone' ? { steps: steps.slice(0, i), ran: false, cloned: steps[i].name } : { steps: steps.slice(0, i + 1), ran: true };
}

/** Why a builder's local may be given steps this reading does not see, or null: the first use of it that is not a step. */
function escapeOf(project, site, at, roleOf) {
  const file = site.call.file;
  for (const u of project.uses ?? []) {
    if (u.file !== file || u.at !== at || u.how === 'write') continue;
    if (u.how === 'value' && u.steps.some((s) => ENDS.has(roleOf(s)))) continue;
    return u.how === 'value' ? `${u.steps.join('().')}() at line ${u.line} hands the builder on` : `it is used at line ${u.line} as something other than the receiver of a step`;
  }
  return null;
}

/** A write of the builder's local that gives it something other than a step on itself, or than the builder where it is made, or null. */
const otherWrite = (project, site, at) => (project.uses ?? []).find((u) => u.file === site.call.file && u.at === at && u.how === 'write' && !u.self && u.line !== site.line) ?? null;

/** Every call later in the file on the local the builder is held in, found by where that local is declared, as steps. */
function heldSteps(project, site, at, roleOf) {
  const out = [];
  for (const c of project.calls) {
    if (c === site.call || c.file !== site.call.file || c.rootAt !== at || c.line < site.line) continue;
    const parts = c.callee.split('.');
    if (parts.length !== 2) continue;
    const own = [{ name: parts[1], args: c.args, cond: Boolean(c.cond) }, ...(c.chain ?? []).map((s) => ({ name: s.name, args: s.args, cond: Boolean(c.cond) }))];
    const kept = upToTerminal(own, roleOf);
    out.push(...kept.steps);
    if (kept.cloned) out.cloned = kept.cloned;
  }
  return out;
}

const cloned = (name) => `${name} makes another builder, whose steps are not read here`;

/** The local a builder is held in, when the builder is what it holds: made last in the call, or at the end of its chain. */
function holderOf(site) {
  const c = site.call;
  if (!c.chain && site.index !== site.segs.length - 1) return { at: null };
  return c.chain ? { at: c.chainHolderAt, reassigned: c.chainHolderReassigned } : { at: c.holderAt, reassigned: c.holderReassigned };
}

/**
 * The builder's steps: those chained on it, then those on the local that holds
 * it, unless its chain already ran it. A local written again holds the one
 * builder when every write gives it a step on itself (`q = q.andWhere(...)`);
 * one given anything else may hold another builder at a later step, which is
 * said as an escape. `unread` lists why the steps may be short, and `escaped`
 * says where else the builder goes.
 */
export function builderSteps(project, site, roleOf) {
  const chained = upToTerminal(site.rest.map((s) => ({ name: s.name, args: s.args ?? [], cond: false })), roleOf);
  const unread = chained.cloned ? [cloned(chained.cloned)] : [];
  if (chained.ran || chained.cloned) return { steps: chained.steps, unread, escaped: null };
  const { at, reassigned } = holderOf(site);
  if (!at) return { steps: chained.steps, unread, escaped: null };
  const other = reassigned ? otherWrite(project, site, at) : null;
  if (other) return { steps: chained.steps, unread: [], escaped: `the local that holds it is given another value at line ${other.line}, so a later step may be on another builder` };
  const held = heldSteps(project, site, at, roleOf);
  return { steps: [...chained.steps, ...held], unread: held.cloned ? [cloned(held.cloned)] : [], escaped: escapeOf(project, site, at, roleOf) };
}

/** Entity views, one per entity, as the builder rule reads them, and how an entity argument or a relation is found. */
/** One entity as the builder rule reads it: its columns, key, delete date column and the columns TypeORM sets itself. */
const builderView = (e) => ({
  name: e.name, entity: e, columns: e.columns, pk: e.columns.filter((c) => c.pk).map((c) => c.column), deleteDate: e.columns.find((c) => c.deleteDate)?.column ?? null,
  auto: e.columns.filter((c) => c.auto && !c.join).map((c) => ({ property: c.property, column: c.column, role: c.role, sets: c.auto, insertable: c.insertable })),
});

export function builderContext(project, model, site, entityOfRef) {
  const views = new Map();
  const viewOf = (e) => {
    if (!views.has(e.key)) views.set(e.key, builderView(e));
    return views.get(e.key);
  };
  const ref = (v) => (v && v.k === 'id' ? { file: site.call.file, name: v.v } : v && v.k === 'str' ? { entityName: v.v } : null);
  return {
    viewOf,
    ctx: {
      entityOf: (v) => { const e = entityOfRef(project, model, ref(v)); return e ? viewOf(e) : null; },
      relationOf: (view, prop) => { const r = view.entity.relations.find((x) => x.property === prop); return r && r.target ? { target: viewOf(r.target) } : null; },
    },
    alias: strArg(site.args[site.argsFrom]),
  };
}
