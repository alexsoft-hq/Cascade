// typeorm_builder.mjs — the steps of one query builder, gathered from where the source writes them.
//
// `const qb = getRepository(Article).createQueryBuilder('article').leftJoin(...)`
// then `if (tag) qb.andWhere('article.tagList LIKE :tag')` and `qb.getMany()`:
// one builder, whose steps are the calls chained where it is made and every
// call written later on the local that holds it (by where that local is
// declared, so another local spelled `qb` is another builder). A step
// written under a condition, in a loop or in a callback is marked, and what it
// reads MAY be read. A chain stops at the step that runs the query: what is
// called on the rows it returns is not the builder's.

const strArg = (v) => (v && v.k === 'str' ? v.v : null);

/** Steps up to and with the first that runs the query; `ran` says whether one did. */
function upToTerminal(steps, roleOf) {
  const i = steps.findIndex((s) => ['rows', 'count'].includes(roleOf(s.name)));
  return i < 0 ? { steps, ran: false } : { steps: steps.slice(0, i + 1), ran: true };
}

/** Every call later in the file on the local the builder is held in, found by where that local is declared, as steps. */
function heldSteps(project, site, at, roleOf) {
  const out = [];
  for (const c of project.calls) {
    if (c === site.call || c.file !== site.call.file || c.rootAt !== at || c.line < site.line) continue;
    const parts = c.callee.split('.');
    if (parts.length !== 2) continue;
    const own = [{ name: parts[1], args: c.args, cond: Boolean(c.cond) }, ...(c.chain ?? []).map((s) => ({ name: s.name, args: s.args, cond: Boolean(c.cond) }))];
    out.push(...upToTerminal(own, roleOf).steps);
  }
  return out;
}

/**
 * The builder's steps: those chained on it, then those on the local that holds
 * it, unless its chain already ran it. `unread` says why the steps may be
 * short: a local written again may hold another builder at a later step.
 */
export function builderSteps(project, site, roleOf) {
  const chained = upToTerminal(site.rest.map((s) => ({ name: s.name, args: s.args ?? [], cond: false })), roleOf);
  if (chained.ran) return { steps: chained.steps, unread: null };
  const at = site.call.chain ? site.call.chainHolderAt : site.call.holderAt;
  const reassigned = site.call.chain ? site.call.chainHolderReassigned : site.call.holderReassigned;
  const lastIsBuilder = site.call.chain ? true : site.index === site.segs.length - 1;
  if (!at || !lastIsBuilder) return { steps: chained.steps, unread: null };
  if (reassigned) return { steps: chained.steps, unread: 'the builder is held in a local that is written again, so a later step may be on another builder' };
  return { steps: [...chained.steps, ...heldSteps(project, site, at, roleOf)], unread: null };
}

/** Entity views, one per entity, as the builder rule reads them, and how an entity argument or a relation is found. */
export function builderContext(project, model, site, entityOfRef) {
  const views = new Map();
  const viewOf = (e) => {
    if (!views.has(e.key)) {
      views.set(e.key, { name: e.name, entity: e, columns: e.columns, pk: e.columns.filter((c) => c.pk).map((c) => c.column), deleteDate: e.columns.find((c) => c.deleteDate)?.column ?? null });
    }
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
