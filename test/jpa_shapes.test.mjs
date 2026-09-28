// jpa_shapes.test.mjs — JPA mapping shapes the bridge used to read as the
// simplest case, and grade EXACT (Astra's third review, N2 and R13).
//
// Each one is a mapping whose table or column the specification, or Spring
// Boot's naming, puts somewhere other than the obvious place:
//
//   * a Map-valued association targets the Map's VALUE type, not its key;
//   * a subclass in a JOINED hierarchy keeps its inherited columns on the
//     parent's table, and joins it by the primary key;
//   * a subclass in a SINGLE_TABLE hierarchy (the default) has no table of its
//     own: every row is in the root's;
//   * a join table nobody names is named by Spring Boot's implicit rule, the
//     owning table and the attribute, and so is its inverse column;
//   * a unidirectional @OneToMany with no @JoinColumn goes through a join table;
//   * an @ElementCollection's values live in a table of their own, which this
//     lane does not read: it says so, and draws no column on the owner.
//
// The facts are hand-written in the shape JavaFacts (javafacts/21) emits, so the
// expectations are read off the annotations, not off the bridge.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Graph, nodeId } from '../src/core/graph.mjs';
import { addJavaFacts } from '../src/adapters/java_bridge.mjs';
import { addJpaFacts } from '../src/adapters/jpa_bridge.mjs';

const P = 'com.example';
const G = () => new Graph();
const tableId = (t) => nodeId('table', t);
const colId = (t, c) => nodeId('column', `${t}.${c}`);
const stmtId = (repo, m) => nodeId('statement', `${P}.${repo}.${m}`);
const DECLARED = { namingStrategy: 'spring-snake-case' };

const type = (simple, extra = {}) => ({
  kind: 'type', fqn: `${P}.${simple}`, typeKind: extra.typeKind ?? 'class', package: P,
  annotations: extra.annotations ?? [], implements: extra.implements ?? [], extends: extra.extends ?? null,
  file: `${simple}.java`,
});
const attr = (name, extra = {}) => ({
  name, typeSimple: extra.typeSimple ?? 'String', typeArgSimple: extra.typeArgSimple ?? null,
  typeArgSimples: extra.typeArgSimples ?? (extra.typeArgSimple ? [extra.typeArgSimple] : []),
  line: 1, column: extra.column ?? null, id: extra.id === true,
  transient: false, relation: extra.relation ?? null, mappedBy: extra.mappedBy ?? null,
  fetch: extra.fetch ?? null, targetEntity: null,
  cascade: extra.cascade ?? [], joinColumn: extra.joinColumn ?? null, joinTable: extra.joinTable ?? null,
  embedded: false, elementCollection: extra.elementCollection === true,
  annotations: extra.annotations ?? [],
});
const entity = (simple, extra = {}) => ({
  kind: 'entity', fqn: `${P}.${simple}`, tableName: extra.tableName ?? null,
  entityName: extra.entityName ?? null, inheritance: extra.inheritance ?? null,
  primaryKeyJoinColumn: extra.primaryKeyJoinColumn ?? null,
  entity: true, mappedSuperclass: false, embeddable: false, superclass: extra.superclass ?? null,
  attributes: extra.attributes ?? [], namedEntityGraphs: [], line: 1, file: `${simple}.java`,
});
const repository = (simple, entityTypeSimple, methods = []) => ({
  kind: 'repository', fqn: `${P}.${simple}`, base: 'JpaRepository',
  entityTypeSimple, idTypeSimple: 'Integer', methods, line: 1, file: `${simple}.java`,
});
const method = (name, extra = {}) => ({ name, line: 10, params: extra.params ?? [], query: extra.query ?? null, modifying: false, entityGraph: null });
const id = () => attr('id', { typeSimple: 'Integer', id: true });

/** The tables one statement reaches, with the access recorded on each. */
const tablesOf = (g, sid) => g.edges
  .filter((e) => e.from === sid && e.type === 'EXECUTES')
  .map((e) => `${e.to.slice('table:'.length)}:${e.evidence.access}`)
  .sort();
const readsOf = (g, sid) => g.edges.filter((e) => e.from === sid && e.type === 'READS').map((e) => `${e.to.slice('column:'.length)}:${e.grade}`).sort();
const joined = (g, a, b) => g.edges.find((e) => e.type === 'JOINS' && [e.from, e.to].includes(tableId(a)) && [e.from, e.to].includes(tableId(b)));
const reasons = (stats) => stats.unresolved.map((u) => u.reason);

test('jpa_map_valued_association_targets_the_value_type: Map<PetType, Pet> is a collection of pets', () => {
  const facts = [
    type('Owner', { annotations: ['Entity', 'Table'] }),
    entity('Owner', {
      tableName: 'owners',
      attributes: [id(), attr('petsByType', {
        typeSimple: 'Map', typeArgSimple: 'PetType', typeArgSimples: ['PetType', 'Pet'],
        relation: 'oneToMany', mappedBy: 'owner', fetch: 'EAGER',
      })],
    }),
    type('Pet', { annotations: ['Entity', 'Table'] }),
    entity('Pet', { tableName: 'pets', attributes: [id(), attr('owner', { typeSimple: 'Owner', relation: 'manyToOne', joinColumn: 'owner_id', fetch: 'LAZY' })] }),
    type('PetType', { annotations: ['Entity', 'Table'] }),
    entity('PetType', { tableName: 'types', attributes: [id()] }),
    type('OwnerRepository', { typeKind: 'interface', implements: ['JpaRepository'] }),
    repository('OwnerRepository', 'Owner', [method('findByIdGreaterThan', { params: ['Integer'] })]),
  ];
  const g = G();
  addJpaFacts(g, facts);
  assert.equal(joined(g, 'owners', 'types'), undefined, 'the key type is not the other side');
  assert.deepEqual(tablesOf(g, stmtId('OwnerRepository', 'findByIdGreaterThan')), ['owners:read', 'pets:read'],
    'the eager map brings back the pets, not the types');
});

/** Animal is the root of a hierarchy, with `strategy` as its @Inheritance writes it. */
function hierarchy(strategy, subExtra = {}) {
  return [
    type('Animal', { annotations: ['Entity', 'Table', 'Inheritance'] }),
    entity('Animal', { tableName: 'animals', inheritance: strategy, attributes: [id(), attr('name')] }),
    type('Dog', { annotations: ['Entity'], extends: 'Animal' }),
    entity('Dog', { superclass: 'Animal', attributes: [attr('breed')], ...subExtra }),
    type('DogRepository', { typeKind: 'interface', implements: ['JpaRepository'] }),
    repository('DogRepository', 'Dog', [method('findByName', { params: ['String'] }), method('findByBreed', { params: ['String'] })]),
    type('AnimalRepository', { typeKind: 'interface', implements: ['JpaRepository'] }),
    repository('AnimalRepository', 'Animal', [method('findByName', { params: ['String'] })]),
  ];
}

test('jpa_joined_inheritance_reads_parent_table_columns: an inherited attribute is a column of the parent table', () => {
  const g = G();
  const stats = addJpaFacts(g, hierarchy('JOINED', { tableName: 'dogs' }), DECLARED);
  assert.equal(g.nodes.has(colId('dogs', 'name')), false, 'name is Animal\'s, so it lives on animals');
  assert.ok(g.nodes.has(colId('animals', 'name')));
  assert.ok(g.nodes.has(colId('dogs', 'breed')));
  assert.ok(g.nodes.has(colId('dogs', 'id')), 'the subclass table carries the primary key that joins it to the parent');
  const j = joined(g, 'dogs', 'animals');
  assert.ok(j, 'dogs joins animals by the key');
  assert.deepEqual(j.evidence.columns, ['dogs.id=animals.id']);
  const byName = stmtId('DogRepository', 'findByName');
  assert.deepEqual(readsOf(g, byName), ['animals.name:EXACT']);
  assert.deepEqual(tablesOf(g, byName), ['animals:read', 'dogs:read'], 'a Dog is one row in each table');
  assert.deepEqual(readsOf(g, stmtId('DogRepository', 'findByBreed')), ['dogs.breed:EXACT']);
  // A query on the parent is polymorphic: it also reads the subclasses' tables, which this lane does not follow.
  const onRoot = g.nodes.get(stmtId('AnimalRepository', 'findByName'));
  assert.deepEqual(onRoot.unresolved.map((u) => u.reason), ['polymorphic-subclasses-not-read']);
  assert.match(onRoot.unresolved[0].detail, /com\.example\.Dog/);
  assert.equal(reasons(stats).includes('inheritance-strategy-unread'), false);
});

test('a JOINED subclass names its key column with @PrimaryKeyJoinColumn', () => {
  const g = G();
  addJpaFacts(g, hierarchy('JOINED', { tableName: 'dogs', primaryKeyJoinColumn: 'animal_id' }), DECLARED);
  assert.ok(g.nodes.has(colId('dogs', 'animal_id')));
  assert.equal(g.nodes.has(colId('dogs', 'id')), false);
  assert.deepEqual(joined(g, 'dogs', 'animals').evidence.columns, ['dogs.animal_id=animals.id']);
});

test('jpa_single_table_subclass_uses_root_table: a subclass with no strategy written shares the root\'s table', () => {
  const g = G();
  addJpaFacts(g, hierarchy(null), DECLARED);
  assert.equal(g.nodes.has(tableId('dog')), false, 'SINGLE_TABLE is the default: no table of its own');
  assert.ok(g.nodes.has(colId('animals', 'breed')));
  assert.deepEqual(readsOf(g, stmtId('DogRepository', 'findByBreed')), ['animals.breed:EXACT']);
  assert.deepEqual(tablesOf(g, stmtId('DogRepository', 'findByName')), ['animals:read']);
  // A @Table on a subclass of a single-table hierarchy is ignored by Hibernate, which warns about it.
  const g2 = G();
  addJpaFacts(g2, hierarchy('SINGLE_TABLE', { tableName: 'dogs' }), DECLARED);
  assert.equal(g2.nodes.has(tableId('dogs')), false);
  assert.ok(g2.nodes.has(colId('animals', 'breed')));
});

test('TABLE_PER_CLASS keeps every column, inherited ones too, on the subclass\'s own table', () => {
  const g = G();
  addJpaFacts(g, hierarchy('TABLE_PER_CLASS', { tableName: 'dogs' }), DECLARED);
  assert.ok(g.nodes.has(colId('dogs', 'name')));
  assert.ok(g.nodes.has(colId('dogs', 'breed')));
  assert.deepEqual(tablesOf(g, stmtId('DogRepository', 'findByName')), ['dogs:read']);
});

test('a strategy this lane does not know is said, and the subclass\'s table is not EXACT', () => {
  const g = G();
  const stats = addJpaFacts(g, hierarchy('SOMETHING_ELSE', { tableName: 'dogs' }), DECLARED);
  assert.ok(reasons(stats).includes('inheritance-strategy-unread'));
  assert.equal(g.nodes.get(tableId('dogs')).jpaMappingGrade, 'HEURISTIC');
});

test('an entity name with no @Table names the default table', () => {
  const g = G();
  addJpaFacts(g, [type('Dog', { annotations: ['Entity'] }), entity('Dog', { entityName: 'Hound', attributes: [id()] })], DECLARED);
  assert.ok(g.nodes.has(tableId('hound')));
  assert.equal(g.nodes.has(tableId('dog')), false);
});

/** Owner with `attribute` of `relation` to Tag, and nothing naming the physical side. */
function ownerAndTags(attribute, tagAttributes = []) {
  return [
    type('Owner', { annotations: ['Entity', 'Table'] }),
    entity('Owner', { tableName: 'owners', attributes: [id(), attribute] }),
    type('Tag', { annotations: ['Entity', 'Table'] }),
    entity('Tag', { tableName: 'tags', attributes: [id(), ...tagAttributes] }),
  ];
}

test('jpa_default_join_table_follows_spring_implicit_naming: the owning table, then the attribute', () => {
  const g = G();
  addJpaFacts(g, ownerAndTags(attr('specialTags', { typeSimple: 'Set', typeArgSimple: 'Tag', relation: 'manyToMany' })), DECLARED);
  assert.ok(g.nodes.has(tableId('owners_special_tags')), 'SpringImplicitNamingStrategy: owners + _ + specialTags, then snake case');
  assert.equal(g.nodes.has(tableId('owner_tag')), false);
  assert.ok(g.nodes.has(colId('owners_special_tags', 'owner_id')), 'unidirectional: the owning entity\'s name, _, its key');
  assert.ok(g.nodes.has(colId('owners_special_tags', 'special_tags_id')), 'the attribute\'s name, _, the target\'s key');
  assert.equal(joined(g, 'owners', 'owners_special_tags').grade, 'EXACT');
  // Bidirectional: the owning side's column is named by the inverse attribute (JPA 2.10.4).
  const g2 = G();
  addJpaFacts(g2, ownerAndTags(
    attr('tags', { typeSimple: 'Set', typeArgSimple: 'Tag', relation: 'manyToMany' }),
    [attr('owners', { typeSimple: 'Set', typeArgSimple: 'Owner', relation: 'manyToMany', mappedBy: 'tags' })],
  ), DECLARED);
  assert.ok(g2.nodes.has(colId('owners_tags', 'owners_id')));
  assert.ok(g2.nodes.has(colId('owners_tags', 'tags_id')));
  // Undeclared naming: the same names, HEURISTIC.
  const g3 = G();
  addJpaFacts(g3, ownerAndTags(attr('tags', { typeSimple: 'Set', typeArgSimple: 'Tag', relation: 'manyToMany' })));
  assert.equal(joined(g3, 'owners', 'owners_tags').grade, 'HEURISTIC');
});

test('jpa_unidirectional_one_to_many_without_join_column_uses_join_table: no mappedBy and no @JoinColumn', () => {
  const facts = [
    ...ownerAndTags(attr('tags', { typeSimple: 'List', typeArgSimple: 'Tag', relation: 'oneToMany', fetch: 'EAGER' })),
    type('OwnerRepository', { typeKind: 'interface', implements: ['JpaRepository'] }),
    repository('OwnerRepository', 'Owner', [method('findByIdGreaterThan', { params: ['Integer'] })]),
  ];
  const g = G();
  addJpaFacts(g, facts, DECLARED);
  assert.equal(g.nodes.has(colId('tags', 'owner_id')), false, 'no foreign key on the target');
  assert.ok(g.nodes.has(colId('owners_tags', 'owner_id')));
  assert.ok(g.nodes.has(colId('owners_tags', 'tags_id')));
  assert.deepEqual(tablesOf(g, stmtId('OwnerRepository', 'findByIdGreaterThan')), ['owners:read', 'owners_tags:read', 'tags:read']);
});

test('jpa_element_collection_is_not_owner_column: the values live in a table this lane does not read, and it says so', () => {
  const facts = [
    type('Owner', { annotations: ['Entity', 'Table'] }),
    entity('Owner', { tableName: 'owners', attributes: [id(), attr('phones', { typeSimple: 'Set', typeArgSimple: 'String', elementCollection: true })] }),
  ];
  const g = G();
  const stats = addJpaFacts(g, facts, DECLARED);
  assert.equal(g.nodes.has(colId('owners', 'phones')), false);
  const said = stats.unresolved.find((u) => u.reason === 'element-collection-not-read');
  assert.ok(said, 'the pack says what it did not read');
  assert.match(said.detail, /com\.example\.Owner\.phones/);
});

test('a JOINED subclass\'s save writes both tables, and the chain reaches it through a service call', () => {
  const facts = [
    ...hierarchy('JOINED', { tableName: 'dogs' }),
    type('DogService', { annotations: ['Service'] }),
    { kind: 'field', owner: `${P}.DogService`, name: 'dogs', typeSimple: 'DogRepository', file: 'DogService.java' },
    { kind: 'method', fqn: `${P}.DogService#add`, owner: `${P}.DogService`, name: 'add', paramCount: 1, line: 5, file: 'DogService.java' },
    { kind: 'call', from: `${P}.DogService#add`, receiver: 'dogs', method: 'save', toTypeSimple: 'DogRepository', file: 'DogService.java' },
  ];
  const g = G();
  addJavaFacts(g, facts);
  addJpaFacts(g, facts, DECLARED);
  const save = stmtId('DogRepository', 'save');
  assert.deepEqual(tablesOf(g, save), ['animals:write', 'dogs:write']);
  const writes = g.edges.filter((e) => e.from === save && e.type === 'WRITES').map((e) => e.to.slice('column:'.length)).sort();
  assert.deepEqual(writes, ['animals.id', 'animals.name', 'dogs.breed', 'dogs.id']);
});

test('jpa_unread_mapping_is_heuristic_and_said: a mapping annotation this lane does not read never leaves its column EXACT', () => {
  const facts = [
    type('Posts', { annotations: ['Entity', 'Table'] }),
    entity('Posts', { tableName: 'posts', attributes: [id()] }),
    type('Comment', { annotations: ['Entity', 'Table'] }),
    entity('Comment', {
      tableName: 'comments',
      attributes: [
        id(),
        // a composite foreign key: @JoinColumns, which names two columns this lane does not read
        attr('posts', { typeSimple: 'Posts', relation: 'manyToOne', annotations: ['MapsId', 'ManyToOne', 'JoinColumns'] }),
        // @MapsId with the column named outright is read as written
        attr('board', { typeSimple: 'Posts', relation: 'manyToOne', joinColumn: 'board_no', annotations: ['MapsId', 'ManyToOne', 'JoinColumn'] }),
      ],
    }),
    type('Audit', { annotations: ['Entity', 'Table', 'SecondaryTable'] }),
    entity('Audit', { tableName: 'audits', attributes: [id(), attr('detail')] }),
  ];
  const g = G();
  const stats = addJpaFacts(g, facts, DECLARED);
  const declares = (t, c) => g.edges.find((e) => e.type === 'DECLARES' && e.to === colId(t, c))?.grade;
  assert.equal(declares('comments', 'posts_id'), 'HEURISTIC');
  assert.equal(declares('comments', 'board_no'), 'EXACT');
  assert.equal(declares('audits', 'detail'), 'HEURISTIC', 'a secondary table may hold any column of the entity');
  const said = stats.unresolved.filter((u) => u.reason === 'jpa-mapping-unread').map((u) => u.detail);
  assert.equal(said.length, 2);
  assert.match(said.join(' | '), /com\.example\.Comment\.posts .*@JoinColumns/);
  assert.match(said.join(' | '), /com\.example\.Audit .*@SecondaryTable/);
});
