// jpa_fetch.test.mjs — WHAT A JPA QUERY REALLY READS (RM54).
//
// A repository method names one entity and reads several tables. `findById` on
// an Owner whose `pets` is `fetch = EAGER` issues one round trip that brings the
// pets back, and their `type` with them, because a @ManyToOne is eager unless
// the mapping says otherwise. Until this round the bridge said `owners` and
// stopped, and a real agent capture of spring-petclinic disagreed on six of its
// ten routes.
//
// Everything below is hand-written evidence in the shape JavaFacts emits
// (javafacts/10), so the expectations are read off the ANNOTATIONS. What is
// pinned:
//
//   1. the eager closure — explicit and default, through a join table, cycle
//      safe, depth capped, and LAZY left out and counted;
//   2. the query's own plan — a JOIN FETCH and an @EntityGraph are followed
//      whatever the mapping's fetch says, and a path that names no association
//      is reported;
//   3. cascade on a save and on a delete;
//   4. the evidence every one of those edges carries: which rule, which
//      attribute path, and whether the fetch was written down or defaulted.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Graph, nodeId } from '../src/core/graph.mjs';
import { addJpaFacts } from '../src/adapters/jpa_bridge.mjs';

const P = 'com.example';
const G = () => new Graph();
const tableId = (t) => nodeId('table', t);
const colId = (t, c) => nodeId('column', `${t}.${c}`);
const stmtId = (repo, m) => nodeId('statement', `${P}.${repo}.${m}`);

const type = (simple, extra = {}) => ({
  kind: 'type', fqn: `${P}.${simple}`, typeKind: extra.typeKind ?? 'class', package: P,
  annotations: extra.annotations ?? [], implements: extra.implements ?? [], extends: extra.extends ?? null,
  file: `${simple}.java`,
});
const attr = (name, extra = {}) => ({
  name, typeSimple: extra.typeSimple ?? 'String', typeArgSimple: extra.typeArgSimple ?? null,
  line: 1, column: extra.column ?? null, id: extra.id === true,
  transient: extra.transient === true, relation: extra.relation ?? null, mappedBy: extra.mappedBy ?? null,
  fetch: extra.fetch ?? null, targetEntity: extra.targetEntity ?? null,
  cascade: extra.cascade ?? [], joinColumn: extra.joinColumn ?? null, joinTable: extra.joinTable ?? null,
  embedded: false,
});
const entity = (simple, extra = {}) => ({
  kind: 'entity', fqn: `${P}.${simple}`, tableName: extra.tableName ?? null,
  entity: true, mappedSuperclass: false, embeddable: false, superclass: null,
  attributes: extra.attributes ?? [], namedEntityGraphs: extra.namedEntityGraphs ?? [],
  line: 1, file: `${simple}.java`,
});
const repository = (simple, extra = {}) => ({
  kind: 'repository', fqn: `${P}.${simple}`, base: 'JpaRepository',
  entityTypeSimple: extra.entityTypeSimple ?? null, idTypeSimple: 'Integer',
  methods: extra.methods ?? [], line: 1, file: `${simple}.java`,
});
const method = (name, extra = {}) => ({
  name, line: 10, params: [], query: extra.query ?? null, modifying: false,
  entityGraph: extra.entityGraph ?? null,
});

/** The tables one statement reaches, with the access recorded on each. */
const tablesOf = (g, sid) => g.edges
  .filter((e) => e.from === sid && e.type === 'EXECUTES')
  .map((e) => `${e.to.slice('table:'.length)}:${e.evidence.access}`)
  .sort();
/** The columns one statement reads or writes. */
const columnsOf = (g, sid, edgeType) => g.edges
  .filter((e) => e.from === sid && e.type === edgeType)
  .map((e) => e.to.slice('column:'.length))
  .sort();
const evidenceOn = (g, sid, columnId) => (g.edges.find((e) => e.from === sid && e.to === columnId) ?? {}).evidence;

/**
 * The petclinic shape, with the fetch the real mapping writes: Owner.pets is
 * eager and cascades, Pet.type is a plain @ManyToOne (eager by the JPA default),
 * Pet.visits is eager and cascades.
 */
function petclinicFacts(ownerPetsFetch = 'EAGER', petVisitsFetch = 'EAGER') {
  return [
    type('Owner', { annotations: ['Entity', 'Table'] }),
    entity('Owner', {
      tableName: 'owners',
      attributes: [
        attr('id', { typeSimple: 'Integer', id: true }),
        attr('lastName'),
        attr('pets', {
          typeSimple: 'List', typeArgSimple: 'Pet', relation: 'oneToMany',
          fetch: ownerPetsFetch, cascade: ['ALL'], joinColumn: 'owner_id',
        }),
      ],
    }),
    type('Pet', { annotations: ['Entity', 'Table'] }),
    entity('Pet', {
      tableName: 'pets',
      attributes: [
        attr('id', { typeSimple: 'Integer', id: true }),
        attr('name'),
        // No `fetch =` at all: a @ManyToOne is EAGER by the specification.
        attr('type', { typeSimple: 'PetType', relation: 'manyToOne', joinColumn: 'type_id' }),
        attr('visits', {
          typeSimple: 'Set', typeArgSimple: 'Visit', relation: 'oneToMany',
          fetch: petVisitsFetch, cascade: ['ALL'], joinColumn: 'pet_id',
        }),
      ],
    }),
    type('PetType', { annotations: ['Entity', 'Table'] }),
    entity('PetType', {
      tableName: 'types',
      attributes: [attr('id', { typeSimple: 'Integer', id: true }), attr('name')],
    }),
    type('Visit', { annotations: ['Entity', 'Table'] }),
    entity('Visit', {
      tableName: 'visits',
      attributes: [attr('id', { typeSimple: 'Integer', id: true }), attr('description')],
    }),
    type('OwnerRepository', { typeKind: 'interface', implements: ['JpaRepository'] }),
    repository('OwnerRepository', {
      entityTypeSimple: 'Owner',
      methods: [method('findById'), method('findByLastName')],
    }),
  ];
}

// ---------------------------------------------------------------------------
// the eager closure
// ---------------------------------------------------------------------------

test('an EAGER association is followed, and so is everything eager on the row it brings back', () => {
  const g = G();
  const stats = addJpaFacts(g, petclinicFacts(), { namingStrategy: 'spring-snake-case' });
  const sid = stmtId('OwnerRepository', 'findByLastName');
  // Owner.pets (written EAGER) -> Pet; Pet.type (@ManyToOne, eager by default)
  // -> PetType; Pet.visits (written EAGER) -> Visit. One query, four tables.
  assert.deepEqual(tablesOf(g, sid), ['owners:read', 'pets:read', 'types:read', 'visits:read']);
  // The eager row is read WHOLE, exactly as the root's own row is.
  assert.deepEqual(columnsOf(g, sid, 'READS').filter((c) => c.startsWith('pets.')),
    ['pets.id', 'pets.name', 'pets.owner_id', 'pets.type_id']);
  assert.deepEqual(columnsOf(g, sid, 'READS').filter((c) => c.startsWith('types.')), ['types.id', 'types.name']);
  assert.equal(stats.lazyAssociationsNotFollowed, 0, 'nothing here is lazy');
});

test('the evidence says WHICH rule reached each table and whether the fetch was written down', () => {
  const g = G();
  addJpaFacts(g, petclinicFacts(), { namingStrategy: 'spring-snake-case' });
  const sid = stmtId('OwnerRepository', 'findById');
  const pets = evidenceOn(g, sid, colId('pets', 'name'));
  assert.equal(pets.rule, 'jpa-eager-fetch');
  assert.equal(pets.fetch, 'explicit', 'Owner.pets writes `fetch = EAGER`');
  assert.equal(pets.path, 'Owner.pets');
  assert.ok(pets.basis.length > 60, 'a rule needs a sentence, not a label');
  const types = evidenceOn(g, sid, colId('types', 'name'));
  assert.equal(types.fetch, 'default', 'Pet.type writes no fetch, and a to-one is eager by the specification');
  assert.equal(types.path, 'Owner.pets.type', 'the path is spelled from the entity the query returns');
  // The TABLE edge carries it too, so a reader who only sees `flow` is told why.
  const exec = g.edges.find((e) => e.from === sid && e.to === tableId('types') && e.type === 'EXECUTES');
  assert.equal(exec.evidence.rule, 'jpa-eager-fetch');
  assert.equal(exec.evidence.access, 'read');
});

test('a LAZY association stays out, and the statement says how much of the row it did not read', () => {
  const g = G();
  const stats = addJpaFacts(g, petclinicFacts('LAZY'), { namingStrategy: 'spring-snake-case' });
  const sid = stmtId('OwnerRepository', 'findByLastName');
  assert.deepEqual(tablesOf(g, sid), ['owners:read'], 'a lazy collection is not read by this query');
  assert.equal(stats.lazyAssociationsNotFollowed, 2, 'once per statement on this repository');
  const node = g.nodes.get(sid);
  assert.equal(node.jpaEvidence.limits.length, 1);
  assert.match(node.jpaEvidence.limits[0], /LAZY/);
  assert.match(node.jpaEvidence.limits[0], /second query/);
});

test('a @ManyToMany is followed through its JOIN TABLE, and both halves are read', () => {
  const facts = [
    type('Vet', { annotations: ['Entity', 'Table'] }),
    entity('Vet', {
      tableName: 'vets',
      attributes: [
        attr('id', { typeSimple: 'Integer', id: true }),
        attr('lastName'),
        attr('specialties', {
          typeSimple: 'Set', typeArgSimple: 'Specialty', relation: 'manyToMany', fetch: 'EAGER',
          joinTable: { name: 'vet_specialties', joinColumns: ['vet_id'], inverseJoinColumns: ['specialty_id'] },
        }),
      ],
    }),
    type('Specialty', { annotations: ['Entity', 'Table'] }),
    entity('Specialty', {
      tableName: 'specialties',
      attributes: [attr('id', { typeSimple: 'Integer', id: true }), attr('name')],
    }),
    type('VetRepository', { typeKind: 'interface', implements: ['JpaRepository'] }),
    repository('VetRepository', { entityTypeSimple: 'Vet', methods: [method('findAll')] }),
  ];
  const g = G();
  addJpaFacts(g, facts, { namingStrategy: 'spring-snake-case' });
  const sid = stmtId('VetRepository', 'findAll');
  assert.deepEqual(tablesOf(g, sid), ['specialties:read', 'vet_specialties:read', 'vets:read']);
  assert.deepEqual(columnsOf(g, sid, 'READS').filter((c) => c.startsWith('vet_specialties.')),
    ['vet_specialties.specialty_id', 'vet_specialties.vet_id']);
  assert.equal(evidenceOn(g, sid, colId('vet_specialties', 'vet_id')).path, 'Vet.specialties');
});

test('a mapping that loops back on itself is followed once, not for ever', () => {
  const facts = [
    type('Node', { annotations: ['Entity', 'Table'] }),
    entity('Node', {
      tableName: 'nodes',
      attributes: [
        attr('id', { typeSimple: 'Integer', id: true }),
        attr('parent', { typeSimple: 'Node', relation: 'manyToOne', joinColumn: 'parent_id' }),
        attr('peer', { typeSimple: 'Other', relation: 'manyToOne', fetch: 'EAGER', joinColumn: 'peer_id' }),
      ],
    }),
    type('Other', { annotations: ['Entity', 'Table'] }),
    entity('Other', {
      tableName: 'others',
      attributes: [
        attr('id', { typeSimple: 'Integer', id: true }),
        attr('back', { typeSimple: 'Node', relation: 'manyToOne', fetch: 'EAGER', joinColumn: 'node_id' }),
      ],
    }),
    type('NodeRepository', { typeKind: 'interface', implements: ['JpaRepository'] }),
    repository('NodeRepository', { entityTypeSimple: 'Node', methods: [method('findAll')] }),
  ];
  const g = G();
  addJpaFacts(g, facts, { namingStrategy: 'spring-snake-case' });
  const sid = stmtId('NodeRepository', 'findAll');
  assert.deepEqual(tablesOf(g, sid), ['nodes:read', 'others:read']);
});

test('a fetch plan deeper than the cap stops, and says where it stopped', () => {
  // Ten entities, each eager to the next: past eight hops the plan is CUT, and
  // the statement carries the reason rather than a shorter answer with no note.
  const n = 10;
  const facts = [];
  for (let i = 0; i < n; i += 1) {
    facts.push(type(`E${i}`, { annotations: ['Entity', 'Table'] }));
    facts.push(entity(`E${i}`, {
      tableName: `t${i}`,
      attributes: [
        attr('id', { typeSimple: 'Integer', id: true }),
        ...(i + 1 < n ? [attr('next', { typeSimple: `E${i + 1}`, relation: 'manyToOne', joinColumn: 'next_id' })] : []),
      ],
    }));
  }
  facts.push(type('E0Repository', { typeKind: 'interface', implements: ['JpaRepository'] }));
  facts.push(repository('E0Repository', { entityTypeSimple: 'E0', methods: [method('findAll')] }));
  const g = G();
  addJpaFacts(g, facts, { namingStrategy: 'spring-snake-case' });
  const sid = stmtId('E0Repository', 'findAll');
  // The root plus eight hops: t0..t8. t9 is past the cap.
  assert.deepEqual(tablesOf(g, sid), [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => `t${i}:read`).sort());
  const node = g.nodes.get(sid);
  assert.ok(node.unresolved.some((u) => u.reason === 'fetch-depth-capped'),
    'a plan that was cut says so, so the missing table is a known gap and not an absence');
});

// ---------------------------------------------------------------------------
// the query's own plan
// ---------------------------------------------------------------------------

test('JOIN FETCH loads an association the mapping calls LAZY', () => {
  const facts = petclinicFacts('LAZY', 'LAZY');
  facts[facts.length - 1] = repository('OwnerRepository', {
    entityTypeSimple: 'Owner',
    methods: [
      method('withPets', { query: { text: 'SELECT DISTINCT o FROM Owner o LEFT JOIN FETCH o.pets', native: false } }),
      method('withoutPets', { query: { text: 'SELECT DISTINCT o FROM Owner o LEFT JOIN o.pets p', native: false } }),
    ],
  });
  const g = G();
  addJpaFacts(g, facts, { namingStrategy: 'spring-snake-case' });
  const fetched = stmtId('OwnerRepository', 'withPets');
  // The fetch join loads the whole pet row, and the pet's own eager `type` too.
  // `Pet.visits` is lazy here, so it stays out even though the pets came back.
  assert.deepEqual(tablesOf(g, fetched), ['owners:read', 'pets:read', 'types:read']);
  assert.deepEqual(columnsOf(g, fetched, 'READS').filter((c) => c.startsWith('pets.')),
    ['pets.id', 'pets.name', 'pets.owner_id', 'pets.type_id']);
  assert.equal(evidenceOn(g, fetched, colId('pets', 'name')).rule, 'jpql-join-fetch');
  // A plain JOIN is not a fetch: the query walks the table, it does not load the
  // row, so the pet's own eager associations are not brought back either.
  const plain = stmtId('OwnerRepository', 'withoutPets');
  assert.deepEqual(tablesOf(g, plain), ['owners:read', 'pets:read']);
});

test('an @EntityGraph is followed, written out or named by the entity', () => {
  const facts = petclinicFacts('LAZY', 'LAZY');
  facts[1].namedEntityGraphs = [{ name: 'Owner.withPets', attributePaths: ['pets'] }];
  facts[facts.length - 1] = repository('OwnerRepository', {
    entityTypeSimple: 'Owner',
    methods: [
      method('findByLastName', { entityGraph: { name: null, attributePaths: ['pets.visits'] } }),
      method('findById', { entityGraph: { name: 'Owner.withPets', attributePaths: [] } }),
      method('findByLastNameLike', { entityGraph: { name: 'Owner.nowhere', attributePaths: [] } }),
      method('findByIdGreaterThan', { entityGraph: { name: null, attributePaths: ['sausages'] } }),
    ],
  });
  const g = G();
  addJpaFacts(g, facts, { namingStrategy: 'spring-snake-case' });
  // A path names its LEAF, and the hop that reaches it comes with it: loading
  // `pets.visits` cannot happen without loading `pets`.
  const written = stmtId('OwnerRepository', 'findByLastName');
  assert.deepEqual(tablesOf(g, written), ['owners:read', 'pets:read', 'types:read', 'visits:read']);
  assert.equal(evidenceOn(g, written, colId('visits', 'description')).rule, 'jpa-entity-graph');
  // A NAMED plan is resolved against the @NamedEntityGraph the entity declares.
  const named = stmtId('OwnerRepository', 'findById');
  assert.deepEqual(tablesOf(g, named), ['owners:read', 'pets:read', 'types:read']);
  // A name no entity in this pack declares is REPORTED, never guessed at.
  const missing = g.nodes.get(stmtId('OwnerRepository', 'findByLastNameLike'));
  assert.deepEqual(tablesOf(g, stmtId('OwnerRepository', 'findByLastNameLike')), ['owners:read']);
  assert.ok(missing.unresolved.some((u) => u.reason === 'entity-graph-unresolved'));
  // …and a path that names no association of the entity is reported too.
  const nonsense = g.nodes.get(stmtId('OwnerRepository', 'findByIdGreaterThan'));
  assert.ok(nonsense.unresolved.some((u) => u.reason === 'fetch-path-unresolved' && /sausages/.test(u.detail)));
});

test('a derived DELETE loads nothing: it removes rows and hands none back', () => {
  const facts = petclinicFacts();
  facts[facts.length - 1] = repository('OwnerRepository', {
    entityTypeSimple: 'Owner', methods: [method('deleteByLastName')],
  });
  const g = G();
  addJpaFacts(g, facts, { namingStrategy: 'spring-snake-case' });
  assert.deepEqual(tablesOf(g, stmtId('OwnerRepository', 'deleteByLastName')), ['owners:delete']);
});

// ---------------------------------------------------------------------------
// cascade
// ---------------------------------------------------------------------------

/** The petclinic shape plus a service that calls the two built-ins. */
function withBuiltins(calls) {
  return [
    ...petclinicFacts(),
    type('OwnerService', { annotations: ['Service'] }),
    { kind: 'field', owner: `${P}.OwnerService`, name: 'owners', typeSimple: 'OwnerRepository', file: 'OwnerService.java' },
    ...calls.map((m) => ({
      kind: 'call', from: `${P}.OwnerService#run`, receiver: 'owners', method: m,
      toTypeSimple: 'OwnerRepository', file: 'OwnerService.java',
    })),
  ];
}

test('a cascading save writes the child rows, and a cascading delete removes them', () => {
  const facts = withBuiltins(['save', 'delete']);
  const g = G();
  addJpaFacts(g, facts, { namingStrategy: 'spring-snake-case' });

  const save = stmtId('OwnerRepository', 'save');
  // Owner.pets cascades ALL -> pets, and Pet.visits cascades ALL -> visits.
  // Pet.type does NOT cascade, so `types` is not written.
  assert.deepEqual(tablesOf(g, save), ['owners:write', 'pets:write', 'visits:write']);
  const petWrite = evidenceOn(g, save, colId('pets', 'name'));
  assert.equal(petWrite.rule, 'jpa-cascade');
  assert.equal(petWrite.operation, 'save');
  assert.equal(petWrite.path, 'Owner.pets');

  const del = stmtId('OwnerRepository', 'delete');
  assert.deepEqual(tablesOf(g, del), ['owners:delete', 'pets:delete', 'visits:delete']);
  // A delete removes the row whole, so it writes no column, and neither do the
  // rows it cascades to.
  assert.deepEqual(columnsOf(g, del, 'WRITES'), []);
});

test('a cascade that does not include REMOVE is not followed by a delete', () => {
  const facts = withBuiltins(['delete']);
  // Owner.pets cascades PERSIST only: saving reaches the pets, removing does not.
  facts[1].attributes[2].cascade = ['PERSIST'];
  const g = G();
  addJpaFacts(g, facts, { namingStrategy: 'spring-snake-case' });
  assert.deepEqual(tablesOf(g, stmtId('OwnerRepository', 'delete')), ['owners:delete']);
});

test('a built-in read follows the fetch plan; a save does not pretend to', () => {
  const facts = withBuiltins(['findById', 'save']);
  const g = G();
  addJpaFacts(g, facts, { namingStrategy: 'spring-snake-case' });
  // The read brings the eager rows back with it.
  assert.deepEqual(tablesOf(g, stmtId('OwnerRepository', 'findById')),
    ['owners:read', 'pets:read', 'types:read', 'visits:read']);
  // The write reaches only what the CASCADE reaches. A save merges a row; it is
  // not a query whose result somebody reads, and claiming it reads `types`
  // would put a read in the answer that the operation does not make.
  assert.deepEqual(tablesOf(g, stmtId('OwnerRepository', 'save')), ['owners:write', 'pets:write', 'visits:write']);
});

// ---------------------------------------------------------------------------
// targetEntity
// ---------------------------------------------------------------------------

test('`targetEntity` names the other side when the field\'s own type cannot', () => {
  const facts = petclinicFacts();
  // A raw `List pets`: the annotation is the only thing that says what is in it.
  facts[1].attributes[2].typeArgSimple = null;
  facts[1].attributes[2].targetEntity = 'Pet';
  const g = G();
  addJpaFacts(g, facts, { namingStrategy: 'spring-snake-case' });
  assert.deepEqual(tablesOf(g, stmtId('OwnerRepository', 'findById')),
    ['owners:read', 'pets:read', 'types:read', 'visits:read']);
});
