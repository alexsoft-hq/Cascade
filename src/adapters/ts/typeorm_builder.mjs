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
// A builder whose local goes anywhere else (handed to a call, held in another
// local or a field, returned) may be given steps this reading does not see, a
// select that narrows the rows or a where that replaces the filter: what it
// reads is then a candidate set that may be short, and it is said
// (`escaped`).

const strArg = (v) => (v && v.k === 'str' ? v.v : null);

/** Steps up to and with the first that runs the query, or up to a clone, whose steps are another builder's; `ran` says whether one ran it. */
function upToTerminal(steps, roleOf) {
  const i = steps.findIndex((s) => ['rows', 'count', 'clone'].includes(roleOf(s.name)));
  if (i < 0) return { steps, ran: false };
  return roleOf(steps[i].name) === 'clone' ? { steps: steps.slice(0, i), ran: false, cloned: true } : { steps: steps.slice(0, i + 1), ran: true };
}

/** Whether a value written in the source is, or holds, the local declared at `at`. */
function mentions(v, at) {
  if (!v || typeof v !== 'object') return false;
  if (v.k === 'id') return v.at === at;
  const inner = v.k === 'obj' ? Object.values(v.v) : v.k === 'arr' ? v.v : v.k === 'call' ? v.args ?? [] : [];
  return inner.some((x) => mentions(x, at));
}

/** Where a builder's local goes besides the calls made on it, said; null when nowhere. */
function escapeOf(project, site, at) {
  const file = site.call.file;
  const handed = project.calls.find((c) => c.file === file && [c.args, ...(c.chain ?? []).map((st) => st.args)].some((args) => args.some((a) => mentions(a, at))));
  if (handed) return `it is handed to ${handed.callee} at line ${handed.line}`;
  const held = (project.binds ?? []).find((b) => b.file === file && b.values.some((v) => mentions(v, at)));
  if (held) return held.name ? `it is held in ${held.name} as well, at line ${held.line}` : `it is stored where this engine does not follow it, at line ${held.line}`;
  const [cls, member] = String(site.call.in).split('.');
  const returns = project.files.get(file)?.classes.get(cls)?.methods.get(member)?.returns ?? [];
  return returns.some((v) => mentions(v, at)) ? 'it is returned to the caller' : null;
}

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
    if (kept.cloned) out.cloned = true;
  }
  return out;
}

const CLONED = 'a copy made with clone is another builder, whose steps are not read here';

/** The local a builder is held in, when the builder is what it holds: made last in the call, or at the end of its chain. */
function holderOf(site) {
  const c = site.call;
  if (!c.chain && site.index !== site.segs.length - 1) return { at: null };
  return c.chain ? { at: c.chainHolderAt, reassigned: c.chainHolderReassigned } : { at: c.holderAt, reassigned: c.holderReassigned };
}

/**
 * The builder's steps: those chained on it, then those on the local that holds
 * it, unless its chain already ran it. `unread` lists why the steps may be
 * short, and `escaped` says where else the builder goes.
 */
export function builderSteps(project, site, roleOf) {
  const chained = upToTerminal(site.rest.map((s) => ({ name: s.name, args: s.args ?? [], cond: false })), roleOf);
  const unread = chained.cloned ? [CLONED] : [];
  if (chained.ran || chained.cloned) return { steps: chained.steps, unread, escaped: null };
  const { at, reassigned } = holderOf(site);
  if (!at) return { steps: chained.steps, unread, escaped: null };
  if (reassigned) return { steps: chained.steps, unread: ['the builder is held in a local that is written again, so a later step may be on another builder'], escaped: null };
  const held = heldSteps(project, site, at, roleOf);
  return { steps: [...chained.steps, ...held], unread: held.cloned ? [CLONED] : [], escaped: escapeOf(project, site, at) };
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
