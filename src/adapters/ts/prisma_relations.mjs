// prisma_relations.mjs — what each relation field of a schema.prisma joins, read from the schema alone.
//
// A relation is written on the side that holds it: `author User @relation(fields:
// [authorId], references: [id])` puts the link in Post.authorId, pointing at
// User.id. The other side, `posts Post[]`, writes no fields; it is the same
// relation, found on the other model by its name (`@relation("x")`, or none on
// both, which Prisma allows only when the two models share one relation).
//
// Two lists with no fields on either side are an IMPLICIT many-to-many: Prisma
// keeps it in a table of its own, `_` and the relation's name, with no name the
// two model names in alphabetical order joined by `To` (`_OrderToTag`), and two
// columns, `A` pointing at the id of the model first in that order and `B` at
// the other's (prisma.io/docs, "Conventions for relation tables in implicit m-n
// relations"). That is Prisma's own rule, not a guess about this project.
//
// What this cannot read, it says: a relation whose other side is missing or not
// the only candidate, a `fields` list the `references` list does not match, a
// many-to-many of a model with itself (which side is A is not in the schema),
// and an implicit table between models without a one-field id.

/** A field of `model` by name, or null. */
const fieldOf = (model, name) => model.fields.find((f) => f.name === name) ?? null;

const unresolved = (target, why) => ({ kind: 'unresolved', target, why });

/** Whether a relation is one-to-one: neither side a list; null when its other side is not the one field it must be. */
const oneToOne = (f, partners) => (partners.length === 1 ? !f.list && !partners[0].list : null);

/** A relation this side holds: the link is in its own `fields`, pointing at the other model's `references`. */
function heldHere(model, f, target) {
  if (f.references.length !== f.relationFields.length) {
    return unresolved(target, `its @relation names ${f.relationFields.length} field(s) and ${f.references.length} reference(s)`);
  }
  return { kind: 'fk', target, holder: 'self', own: f.relationFields, other: f.references, oneToOne: oneToOne(f, partnersOf(model, f, target)) };
}

/** The fields of `target` that are the other side of `model.f`: same relation name, pointing back at `model`. */
function partnersOf(model, f, target) {
  return target.fields.filter((p) => p.relation && p.type === model.name && p.relationName === f.relationName && !(target === model && p.name === f.name));
}

/** The implicit many-to-many table between two models, when both have a one-field id to point at. */
function implicitTable(model, f, target) {
  if (target === model) return unresolved(target, 'a many-to-many of a model with itself: which of A and B each side is, the schema does not say');
  const [a, b] = [model, target].sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
  if (a.primaryKey.length !== 1 || b.primaryKey.length !== 1) return unresolved(target, 'an implicit many-to-many needs a one-field id on both models');
  if (a.schema !== b.schema) return unresolved(target, 'an implicit many-to-many between two @@schema blocks: which one holds its table, the schema does not say');
  const name = f.relationName ?? `${a.name}To${b.name}`;
  return { kind: 'implicit', target, table: `_${name}`, a, b, selfIsA: a === model };
}

/** A relation this side does not hold: the other side holds it, or it is an implicit many-to-many. */
function heldThere(model, f, target) {
  const partners = partnersOf(model, f, target);
  const holders = partners.filter((p) => p.relationFields.length > 0);
  if (holders.length === 1) {
    const p = holders[0];
    if (p.references.length !== p.relationFields.length) return unresolved(target, `${target.name}.${p.name} names ${p.relationFields.length} field(s) and ${p.references.length} reference(s)`);
    return { kind: 'fk', target, holder: 'target', own: p.references, other: p.relationFields, oneToOne: oneToOne(f, [p]) };
  }
  if (holders.length === 0 && partners.length === 1 && f.list && partners[0].list) return implicitTable(model, f, target);
  return unresolved(target, partners.length === 0
    ? `schema.prisma names no field of ${target.name} that is the other side of it`
    : `${partners.length} fields of ${target.name} could be the other side of it`);
}

/**
 * Every relation field of the schema, keyed `Model.field`: an `fk` relation
 * (`own` the fields on this model's side of the join, `other` the target's,
 * `holder` the side whose fields hold the link, and whether it is `oneToOne`),
 * an `implicit` many-to-many, or `unresolved` with the reason.
 *
 * @param {Map<string, object>} models  readPrismaSchema's models
 * @returns {Map<string, object>}
 */
export function relationsOf(models) {
  const out = new Map();
  for (const model of models.values()) {
    for (const f of model.fields.filter((x) => x.relation)) {
      const target = models.get(f.type);
      const key = `${model.name}.${f.name}`;
      if (!target) out.set(key, unresolved(null, `${f.type} is not a model of schema.prisma`));
      else out.set(key, f.relationFields.length > 0 ? heldHere(model, f, target) : heldThere(model, f, target));
    }
  }
  return out;
}

/** The scalar field `name` of `model`, or null when it is not one: a relation's fields must name columns. */
export function scalarOf(model, name) {
  const f = fieldOf(model, name);
  return f && !f.relation ? f : null;
}
