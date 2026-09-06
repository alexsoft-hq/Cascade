// jpa_bridge.test.mjs — the JPA bridge over synthetic `com.example` facts.
//
// Everything here is hand-written evidence in the shape JavaFacts emits, so the
// expectations are read off the ANNOTATIONS, not off the bridge. The three
// things being pinned down:
//   1. a declared name is EXACT and a derived one is HEURISTIC — and a catalog
//      hit records itself as evidence WITHOUT promoting the grade (I-1);
//   2. inheritance, associations and join tables produce the columns and JOINS
//      the mapping actually implies;
//   3. the chain a service call opens — endpoint -> controller -> repository ->
//      statement -> column — comes back through the SHIPPED tools.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Graph, nodeId } from '../src/core/graph.mjs';
import { buildGraphFromSql } from '../src/adapters/sql_bridge.mjs';
import { addJavaFacts } from '../src/adapters/java_bridge.mjs';
import { addJpaFacts, nativeQueryStatements, normalizeBindParameters, snakeCase, physicalName } from '../src/adapters/jpa_bridge.mjs';
import { callTool } from '../src/mcp/catalog.mjs';
import { computeTrust } from '../src/core/trust.mjs';

// ---------------------------------------------------------------------------
// fact builders
// ---------------------------------------------------------------------------

const P = 'com.example';
const type = (simple, extra = {}) => ({
  kind: 'type', fqn: `${P}.${simple}`, typeKind: extra.typeKind ?? 'class', package: P,
  annotations: extra.annotations ?? [], implements: extra.implements ?? [], extends: extra.extends ?? null,
  file: `${simple}.java`,
});
const attr = (name, extra = {}) => ({
  name, typeSimple: extra.typeSimple ?? 'String', typeArgSimple: extra.typeArgSimple ?? null,
  line: extra.line ?? 1, column: extra.column ?? null, id: extra.id === true,
  transient: extra.transient === true, relation: extra.relation ?? null, mappedBy: extra.mappedBy ?? null,
  cascade: extra.cascade ?? [], joinColumn: extra.joinColumn ?? null, joinTable: extra.joinTable ?? null,
  embedded: extra.embedded === true,
});
const entity = (simple, extra = {}) => ({
  kind: 'entity', fqn: `${P}.${simple}`, tableName: extra.tableName ?? null,
  entity: extra.entity !== false, mappedSuperclass: extra.mappedSuperclass === true,
  embeddable: extra.embeddable === true, superclass: extra.superclass ?? null,
  attributes: extra.attributes ?? [], line: 1, file: `${simple}.java`,
});
const repository = (simple, extra = {}) => ({
  kind: 'repository', fqn: `${P}.${simple}`, base: extra.base ?? 'JpaRepository',
  entityTypeSimple: extra.entityTypeSimple ?? null, idTypeSimple: 'Integer',
  methods: extra.methods ?? [], line: 1, file: `${simple}.java`,
});
const method = (name, extra = {}) => ({
  name, line: extra.line ?? 10, params: extra.params ?? [], query: extra.query ?? null,
  modifying: extra.modifying === true,
});

/** The petclinic-shaped model, in com.example: Owner/Pet/PetType + superclasses. */
function shopFacts() {
  return [
    type('BaseEntity', { annotations: ['MappedSuperclass'] }),
    entity('BaseEntity', {
      entity: false, mappedSuperclass: true,
      attributes: [attr('id', { typeSimple: 'Integer', id: true })],
    }),
    type('NamedEntity', { annotations: ['MappedSuperclass'], extends: 'BaseEntity' }),
    entity('NamedEntity', {
      entity: false, mappedSuperclass: true, superclass: 'BaseEntity',
      attributes: [attr('name')],
    }),
    type('Owner', { annotations: ['Entity', 'Table'], extends: 'NamedEntity' }),
    entity('Owner', {
      tableName: 'owners', superclass: 'NamedEntity',
      attributes: [
        attr('lastName'),
        attr('homeAddress', { column: 'addr' }),
        attr('secret', { transient: true }),
        attr('pets', { typeSimple: 'List', typeArgSimple: 'Pet', relation: 'oneToMany', joinColumn: 'owner_id', cascade: ['ALL'] }),
      ],
    }),
    type('Pet', { annotations: ['Entity'], extends: 'BaseEntity' }),
    // NO @Table: the table name is DERIVED, so it must come back HEURISTIC.
    entity('Pet', {
      superclass: 'BaseEntity',
      attributes: [
        attr('birthDate', { typeSimple: 'LocalDate' }),
        attr('petType', { typeSimple: 'PetType', relation: 'manyToOne', joinColumn: 'type_id' }),
      ],
    }),
    type('PetType', { annotations: ['Entity', 'Table'], extends: 'BaseEntity' }),
    entity('PetType', { tableName: 'types', superclass: 'BaseEntity', attributes: [] }),
    type('OwnerRepository', { typeKind: 'interface', implements: ['JpaRepository'] }),
    repository('OwnerRepository', {
      entityTypeSimple: 'Owner',
      methods: [method('findByLastName', { params: ['String'] })],
    }),
    { kind: 'method', fqn: `${P}.OwnerRepository#findByLastName`, owner: `${P}.OwnerRepository`, name: 'findByLastName', paramCount: 1, line: 10, file: 'OwnerRepository.java' },
  ];
}

const G = () => new Graph();
const tableId = (t) => nodeId('table', t);
const colId = (t, c) => nodeId('column', `${t}.${c}`);
const gradeOf = (g, type_, from, to) => (g.edges.find((e) => e.type === type_ && e.from === from && e.to === to) ?? {}).grade ?? null;

// ---------------------------------------------------------------------------
// naming
// ---------------------------------------------------------------------------

test('snakeCase follows Spring Boot: CamelCase -> snake_case, acronyms kept whole', () => {
  assert.equal(snakeCase('lastName'), 'last_name');
  assert.equal(snakeCase('PetType'), 'pet_type');
  assert.equal(snakeCase('Owner'), 'owner');
  assert.equal(snakeCase('birthDate'), 'birth_date');
  assert.equal(snakeCase('URL'), 'url');
  assert.equal(snakeCase('myURLValue'), 'my_url_value');
  assert.equal(physicalName('lastName', 'identity'), 'lastName');
});

// ---------------------------------------------------------------------------
// entity -> table / attribute -> column
// ---------------------------------------------------------------------------

test('a declared @Table/@Column is EXACT; a derived name is HEURISTIC when no strategy is declared', () => {
  const g = G();
  addJpaFacts(g, shopFacts());
  // Owner declares @Table(name="owners") -> EXACT
  assert.equal(g.nodes.get(tableId('owners')).jpaMappingGrade, 'EXACT');
  // Pet declares no @Table -> the name is derived by the ASSUMED strategy
  assert.equal(g.nodes.get(tableId('pet')).jpaMappingGrade, 'HEURISTIC');
  // @Column(name="addr") is written down; `lastName` is not.
  assert.equal(gradeOf(g, 'DECLARES', tableId('owners'), colId('owners', 'addr')), 'EXACT');
  assert.equal(gradeOf(g, 'DECLARES', tableId('owners'), colId('owners', 'last_name')), 'HEURISTIC');
});

test('a DECLARED naming strategy makes the derived names EXACT — that is what the profile key buys', () => {
  const g = G();
  const stats = addJpaFacts(g, shopFacts(), { namingStrategy: 'spring-snake-case' });
  assert.equal(stats.namingStrategyDeclared, true);
  assert.equal(g.nodes.get(tableId('pet')).jpaMappingGrade, 'EXACT');
  assert.equal(gradeOf(g, 'DECLARES', tableId('owners'), colId('owners', 'last_name')), 'EXACT');
});

test('I-1: a catalog hit is recorded as evidence and NEVER promotes the derived mapping', () => {
  // The DDL happens to contain a `pet` table. The engine must notice — and stay HEURISTIC.
  const g = buildGraphFromSql([
    { kind: 'table', schema: null, table: 'pet' },
    { kind: 'column', schema: null, table: 'pet', column: 'id' },
  ], []);
  addJpaFacts(g, shopFacts());
  const t = g.nodes.get(tableId('pet'));
  assert.equal(t.jpaCatalogMatch, true, 'the coincidence is recorded');
  assert.equal(t.stub, undefined, 'the catalog node is not a stub');
  assert.equal(t.jpaMappingGrade, 'HEURISTIC', 'and the mapping is STILL heuristic (I-1)');
});

test('an UPPER-CASE DDL and a derived lower-case name are ONE column, not two', () => {
  // THE DEFECT THIS PINS. Oracle, HSQLDB and H2 fold unquoted identifiers to
  // UPPER case, so their DDL spells the key `ID` and the table `OWNERS`, while
  // Spring's naming strategy derives `id` and (from @Table) `owners`. Keyed by
  // string that is TWO nodes for one column: the DDL's, which every SQL
  // statement reaches, and the mapping's, which every repository statement
  // reaches — and `column_impact` on either returns half the truth. It is
  // exactly what jeecg-boot's `sys_user_depart.id`/`.ID` did on the
  // MyBatis-Plus side before that lane was given the same rule.
  const ddl = () => buildGraphFromSql([
    { kind: 'table', schema: null, table: 'OWNERS' },
    { kind: 'column', schema: null, table: 'OWNERS', column: 'ID' },
    { kind: 'column', schema: null, table: 'OWNERS', column: 'LAST_NAME' },
  ], [], { identifierCase: 'fold-upper' });

  // BEFORE: no identity rule reaches the bridge — the split is reproduced.
  const split = ddl();
  addJpaFacts(split, shopFacts());
  assert.ok(split.nodes.has('column:OWNERS.ID'), 'the DDL column');
  assert.ok(split.nodes.has('column:owners.id'), 'and the mapping made a SECOND one');
  assert.ok(split.nodes.has('table:owners'), 'a second table node too');
  const splitReads = split.edges
    .filter((e) => e.from === nodeId('statement', `${P}.OwnerRepository.findByLastName`) && e.type === 'READS')
    .map((e) => e.to);
  assert.deepEqual(splitReads, ['column:owners.last_name'], 'the statement reads the INVENTED column');

  // AFTER: the same rule the SQL lane matched with, handed to the bridge.
  const folded = ddl();
  const stats = addJpaFacts(folded, shopFacts(), { identifierCase: 'fold-upper' });
  assert.equal(folded.nodes.has('column:owners.id'), false, 'no second node for the key');
  assert.equal(folded.nodes.has('column:owners.last_name'), false);
  assert.equal(folded.nodes.has('table:owners'), false, 'and no second table');
  assert.ok(folded.nodes.has('column:OWNERS.ID'));
  const reads = folded.edges
    .filter((e) => e.from === nodeId('statement', `${P}.OwnerRepository.findByLastName`) && e.type === 'READS')
    .map((e) => e.to);
  assert.deepEqual(reads, ['column:OWNERS.LAST_NAME'], 'the statement reaches the DDL\'s own column');
  assert.deepEqual(
    folded.edges.filter((e) => e.from === nodeId('statement', `${P}.OwnerRepository.findByLastName`) && e.type === 'EXECUTES').map((e) => e.to),
    ['table:OWNERS'],
  );
  // I-1 still holds: landing on the catalog node is evidence, not a promotion.
  const t = folded.nodes.get('table:OWNERS');
  assert.equal(t.jpaCatalogMatch, true);
  assert.equal(t.jpaMappingGrade, 'EXACT', 'Owner declares @Table(name="owners") — declared, so EXACT');
  assert.equal(t.stub, undefined);
  // A name the DDL does NOT have keeps what the mapping wrote and stays a stub.
  // Its key is built from the entity's own table spelling (`owners.addr`) while
  // its DECLARES edge comes from the catalog's node — the same shape the
  // MyBatis-Plus lane already produces, so the two bridges agree.
  assert.ok(folded.nodes.has('column:owners.addr'), 'a name the catalog lacks keeps what the mapping wrote');
  assert.equal(folded.nodes.get('column:owners.addr').stub, true);
  assert.ok(folded.edges.some((e) => e.type === 'DECLARES' && e.from === 'table:OWNERS' && e.to === 'column:owners.addr'));
  assert.ok(stats.columnsStubbed > 0);
});

test('a table the catalog does not carry is created as a STUB that says who declared it', () => {
  const g = G();
  addJpaFacts(g, shopFacts());
  assert.equal(g.nodes.get(tableId('owners')).stub, true);
  assert.equal(g.nodes.get(tableId('owners')).declaredBy, 'jpa');
});

test('@MappedSuperclass attributes are inherited down the whole chain', () => {
  const g = G();
  addJpaFacts(g, shopFacts());
  // Owner extends NamedEntity extends BaseEntity: id + name are its columns too.
  for (const c of ['id', 'name', 'last_name', 'addr']) {
    assert.ok(g.nodes.has(colId('owners', c)), `owners.${c} must exist`);
  }
  assert.equal(g.nodes.has(tableId('named_entity')), false, 'a @MappedSuperclass maps to no table');
  assert.equal(g.nodes.has(tableId('base_entity')), false);
});

test('@Transient produces no column, and an inherited chain cycle does not hang the walk', () => {
  const g = G();
  addJpaFacts(g, shopFacts());
  assert.equal(g.nodes.has(colId('owners', 'secret')), false);

  const cyclic = [
    type('A', { annotations: ['Entity'], extends: 'B' }),
    entity('A', { superclass: 'B', attributes: [attr('a')] }),
    type('B', { annotations: ['MappedSuperclass'], extends: 'A' }),
    entity('B', { entity: false, mappedSuperclass: true, superclass: 'A', attributes: [attr('b')] }),
  ];
  const g2 = G();
  addJpaFacts(g2, cyclic); // must return, not hang
  assert.ok(g2.nodes.has(colId('a', 'a')));
  assert.ok(g2.nodes.has(colId('a', 'b')));
});

test('@ManyToOne owns its join column on THIS table and JOINS the target', () => {
  const g = G();
  addJpaFacts(g, shopFacts());
  assert.ok(g.nodes.has(colId('pet', 'type_id')));
  const join = g.edges.find((e) => e.type === 'JOINS'
    && [e.from, e.to].includes(tableId('pet')) && [e.from, e.to].includes(tableId('types')));
  assert.ok(join, 'pet <-> types must be joined by the association');
  // weakest link: Pet's table name is derived (HEURISTIC), so the pair is too.
  assert.equal(join.grade, 'HEURISTIC');
  assert.equal(join.evidence.via, 'jpa-association');
});

test('a unidirectional @OneToMany(@JoinColumn) puts the foreign key on the TARGET table', () => {
  const g = G();
  addJpaFacts(g, shopFacts());
  assert.ok(g.nodes.has(colId('pet', 'owner_id')), 'the FK lives on pet, not on owners');
  assert.equal(g.nodes.has(colId('owners', 'pets')), false, 'a collection is not a column');
});

test('@ManyToMany with a @JoinTable creates the join table and two JOINS edges', () => {
  const facts = [
    type('Vet', { annotations: ['Entity', 'Table'] }),
    entity('Vet', {
      tableName: 'vets',
      attributes: [
        attr('id', { typeSimple: 'Integer', id: true }),
        attr('specialties', {
          typeSimple: 'Set', typeArgSimple: 'Specialty', relation: 'manyToMany',
          joinTable: { name: 'vet_specialties', joinColumns: ['vet_id'], inverseJoinColumns: ['specialty_id'] },
        }),
      ],
    }),
    type('Specialty', { annotations: ['Entity', 'Table'] }),
    entity('Specialty', { tableName: 'specialties', attributes: [attr('id', { typeSimple: 'Integer', id: true })] }),
  ];
  const g = G();
  const stats = addJpaFacts(g, facts);
  const jt = g.nodes.get(tableId('vet_specialties'));
  assert.ok(jt, 'the join table node exists');
  assert.equal(jt.declaredBy, 'jpa');
  assert.equal(jt.stub, true);
  assert.deepEqual(jt.joinTableFor.sort(), [`${P}.Specialty`, `${P}.Vet`]);
  assert.ok(g.nodes.has(colId('vet_specialties', 'vet_id')));
  assert.ok(g.nodes.has(colId('vet_specialties', 'specialty_id')));
  const joins = g.edges.filter((e) => e.type === 'JOINS');
  assert.equal(joins.length, 2);
  // Everything here is declared, so nothing rests on the naming strategy.
  for (const j of joins) assert.equal(j.grade, 'EXACT');
  assert.equal(stats.joins, 2);
});

// ---------------------------------------------------------------------------
// statements
// ---------------------------------------------------------------------------

test('a derived query reads exactly its predicate columns, and binds the method to the statement', () => {
  const g = G();
  const stats = addJpaFacts(g, shopFacts());
  const sid = nodeId('statement', `${P}.OwnerRepository.findByLastName`);
  assert.equal(g.nodes.get(sid).statementType, 'derived');
  assert.equal(g.nodes.get(sid).source, 'jpa');
  assert.equal(gradeOf(g, 'IMPLEMENTS_STMT', nodeId('symbol', `${P}.OwnerRepository#findByLastName`), sid), 'EXACT');
  const reads = g.edges.filter((e) => e.from === sid && e.type === 'READS').map((e) => e.to);
  assert.deepEqual(reads, [colId('owners', 'last_name')]);
  assert.equal(gradeOf(g, 'EXECUTES', sid, tableId('owners')), 'HEURISTIC');
  assert.equal(stats.statementsByType.derived, 1);
});

test('a derived name that does not resolve KEEPS the statement, with the reason on the node', () => {
  const facts = shopFacts().map((r) => (r.kind === 'repository'
    ? { ...r, methods: [method('findByNoSuchThing'), method('fetchEverything')] }
    : r));
  const g = G();
  const stats = addJpaFacts(g, facts);
  const bad = g.nodes.get(nodeId('statement', `${P}.OwnerRepository.findByNoSuchThing`));
  assert.ok(bad, 'the statement is kept');
  assert.equal(bad.hasUnresolved, true);
  assert.equal(bad.unresolved[0].reason, 'property-path-unresolved');
  const worse = g.nodes.get(nodeId('statement', `${P}.OwnerRepository.fetchEverything`));
  assert.equal(worse.unresolved[0].reason, 'derived-name-unreadable');
  assert.equal(stats.unresolvedStatements, 2);
});

test('a @Query JPQL statement resolves its aliases and paths through the entity model', () => {
  const facts = shopFacts().map((r) => (r.kind === 'repository'
    ? {
      ...r,
      methods: [method('search', { query: { text: 'SELECT o.lastName FROM Owner o JOIN o.pets p WHERE p.birthDate > :d', native: false } })],
    }
    : r));
  const g = G();
  addJpaFacts(g, facts);
  const sid = nodeId('statement', `${P}.OwnerRepository.search`);
  assert.equal(g.nodes.get(sid).statementType, 'jpql');
  const reads = g.edges.filter((e) => e.from === sid && e.type === 'READS').map((e) => e.to).sort();
  assert.deepEqual(reads, [colId('owners', 'last_name'), colId('pet', 'birth_date')].sort());
  const tables = g.edges.filter((e) => e.from === sid && e.type === 'EXECUTES').map((e) => e.to).sort();
  assert.deepEqual(tables, [tableId('owners'), tableId('pet')].sort());
});

test('an @Modifying UPDATE writes what its SET names', () => {
  const facts = shopFacts().map((r) => (r.kind === 'repository'
    ? { ...r, methods: [method('rename', { modifying: true, query: { text: 'UPDATE Owner o SET o.lastName = :n WHERE o.id = :id', native: false } })] }
    : r));
  const g = G();
  addJpaFacts(g, facts);
  const sid = nodeId('statement', `${P}.OwnerRepository.rename`);
  assert.deepEqual(g.edges.filter((e) => e.from === sid && e.type === 'WRITES').map((e) => e.to), [colId('owners', 'last_name')]);
  assert.deepEqual(g.edges.filter((e) => e.from === sid && e.type === 'READS').map((e) => e.to), [colId('owners', 'id')]);
  assert.equal(g.edges.find((e) => e.from === sid && e.type === 'EXECUTES').evidence.access, 'write');
});

test('JPA bind markers become the `?` a SQL parser accepts — literals and casts untouched', () => {
  assert.equal(normalizeBindParameters('select id from owners where city = ?1 and x = :name'),
    'select id from owners where city = ? and x = ?');
  assert.equal(normalizeBindParameters("select 'a?1b' from t where y = :v"), "select 'a?1b' from t where y = ?");
  assert.equal(normalizeBindParameters('select x::text from t where a = ?12'), 'select x::text from t where a = ?');
  assert.equal(normalizeBindParameters('select 1 -- ?1\n from t where a = ?2'), 'select 1 -- ?1\n from t where a = ?');
  assert.equal(normalizeBindParameters('select /* :keep */ 1 from t'), 'select /* :keep */ 1 from t');
  assert.equal(normalizeBindParameters('select 1 from t where a = ?'), 'select 1 from t where a = ?');
});

test('nativeQueryStatements hands a native @Query to the SQL lane, verb and all', () => {
  const facts = shopFacts().map((r) => (r.kind === 'repository'
    ? {
      ...r,
      methods: [
        method('raw', { query: { text: 'SELECT last_name FROM owners', native: true } }),
        method('wipe', { query: { text: '  -- clean up\n DELETE FROM owners', native: true } }),
        method('jpqlOne', { query: { text: 'SELECT o FROM Owner o', native: false } }),
      ],
    }
    : r));
  const out = nativeQueryStatements(facts);
  assert.deepEqual(out.map((s) => [s.namespace, s.id, s.type]), [
    [`${P}.OwnerRepository`, 'raw', 'select'],
    [`${P}.OwnerRepository`, 'wipe', 'delete'],
  ]);
  assert.equal(out[0].kind, 'statement');
  assert.equal(out[0].file, 'OwnerRepository.java');
  assert.equal(out[0].sql, 'SELECT last_name FROM owners', 'the SQL text travels as written');
});

// ---------------------------------------------------------------------------
// built-ins
// ---------------------------------------------------------------------------

/** A controller + a service call, so the built-in `save` has a caller. */
function withService(extraMethods = []) {
  return [
    ...shopFacts(),
    type('OwnerController', { annotations: ['RestController'] }),
    { kind: 'field', owner: `${P}.OwnerController`, name: 'owners', typeSimple: 'OwnerRepository', file: 'OwnerController.java' },
    { kind: 'endpoint', httpMethod: 'POST', path: '/owners', handler: `${P}.OwnerController#create`, handlerType: `${P}.OwnerController`, line: 20, file: 'OwnerController.java' },
    { kind: 'method', fqn: `${P}.OwnerController#create`, owner: `${P}.OwnerController`, name: 'create', paramCount: 1, line: 20, file: 'OwnerController.java' },
    { kind: 'call', from: `${P}.OwnerController#create`, receiver: 'owners', method: 'save', toTypeSimple: 'OwnerRepository', file: 'OwnerController.java' },
    ...extraMethods,
  ];
}

test('a built-in `save` the service calls writes EVERY mapped column of the row', () => {
  const g = G();
  addJavaFacts(g, withService());
  const stats = addJpaFacts(g, withService());
  const sid = nodeId('statement', `${P}.OwnerRepository.save`);
  const node = g.nodes.get(sid);
  assert.equal(node.statementType, 'builtin');
  assert.match(node.jpaEvidence.note, /merges the whole entity/);
  const writes = g.edges.filter((e) => e.from === sid && e.type === 'WRITES').map((e) => e.to).sort();
  // Every column of the OWNER row — the inherited ones included — plus the child
  // rows Owner.pets cascades to (asserted on its own, in the cascade test below).
  assert.deepEqual(writes.filter((c) => c.startsWith('column:owners.')), [
    colId('owners', 'addr'), colId('owners', 'id'), colId('owners', 'last_name'), colId('owners', 'name'),
  ].sort());
  assert.deepEqual(writes.filter((c) => c.startsWith('column:pet.')), [
    colId('pet', 'birth_date'), colId('pet', 'id'), colId('pet', 'owner_id'), colId('pet', 'type_id'),
  ].sort(), 'the cascade reaches every column of the child row, including its foreign key');
  assert.equal(g.edges.find((e) => e.from === sid && e.to === tableId('owners') && e.type === 'EXECUTES').evidence.access, 'write');
  assert.equal(stats.builtins, 1);
  // The repository DECLARED findByLastName, so that one is derived, not built-in.
  assert.equal(g.nodes.get(nodeId('statement', `${P}.OwnerRepository.findByLastName`)).statementType, 'derived');
});

test('a cascading save reaches the associated row — as a SOUND_SET candidate, never EXACT', () => {
  const g = G();
  addJavaFacts(g, withService());
  addJpaFacts(g, withService(), { namingStrategy: 'spring-snake-case' });
  const sid = nodeId('statement', `${P}.OwnerRepository.save`);
  // Owner.pets is cascade=ALL, so saving an Owner reaches `pet`.
  const petWrite = g.edges.find((e) => e.from === sid && e.type === 'WRITES' && e.to === colId('pet', 'birth_date'));
  assert.ok(petWrite, 'the cascade reaches the child row');
  assert.equal(petWrite.grade, 'SOUND_SET', 'a cascade is a candidate set — capped, never EXACT');
  assert.equal(petWrite.evidence.via, 'jpa-cascade');
  // …and the OWNER's own columns stay EXACT under a declared strategy.
  assert.equal(gradeOf(g, 'WRITES', sid, colId('owners', 'last_name')), 'EXACT');
});

test('a built-in the service never calls is NOT invented', () => {
  const g = G();
  addJavaFacts(g, withService());
  addJpaFacts(g, withService());
  assert.equal(g.nodes.has(nodeId('statement', `${P}.OwnerRepository.deleteById`)), false);
  assert.equal(g.nodes.has(nodeId('statement', `${P}.OwnerRepository.count`)), false);
});

test('findById reads the primary key column; findAll reads the whole row', () => {
  const calls = ['findById', 'findAll'].map((m) => (
    { kind: 'call', from: `${P}.OwnerController#create`, receiver: 'owners', method: m, toTypeSimple: 'OwnerRepository', file: 'OwnerController.java' }
  ));
  const facts = withService(calls);
  const g = G();
  addJavaFacts(g, facts);
  addJpaFacts(g, facts);
  const byId = nodeId('statement', `${P}.OwnerRepository.findById`);
  assert.deepEqual(g.edges.filter((e) => e.from === byId && e.type === 'READS').map((e) => e.to), [colId('owners', 'id')]);
  const all = nodeId('statement', `${P}.OwnerRepository.findAll`);
  assert.equal(g.edges.filter((e) => e.from === all && e.type === 'READS').length, 4);
});

// ---------------------------------------------------------------------------
// end to end, through the shipped tools
// ---------------------------------------------------------------------------

test('the whole chain answers column_impact and endpoint_impact through callTool', () => {
  const facts = withService([
    { kind: 'call', from: `${P}.OwnerController#search`, receiver: 'owners', method: 'findByLastName', toTypeSimple: 'OwnerRepository', file: 'OwnerController.java' },
    { kind: 'endpoint', httpMethod: 'GET', path: '/owners', handler: `${P}.OwnerController#search`, handlerType: `${P}.OwnerController`, line: 30, file: 'OwnerController.java' },
    { kind: 'method', fqn: `${P}.OwnerController#search`, owner: `${P}.OwnerController`, name: 'search', paramCount: 1, line: 30, file: 'OwnerController.java' },
  ]);
  const g = G();
  addJavaFacts(g, facts);
  addJpaFacts(g, facts, { namingStrategy: 'spring-snake-case' });

  const ctx = {
    graph: g,
    basis: { project: 'x', buildDigest: 'd', builtAt: null, freshness: { verdict: 'unknown' } },
    trust: computeTrust({}), limits: [], pack: { axes: null, laneStats: null }, profile: null,
  };

  const ci = callTool('column_impact', { column: 'owners.last_name' }, ctx);
  assert.deepEqual(ci.answer.statements.map((s) => [s.id.replace(`${P}.OwnerRepository.`, ''), s.access, s.grade]).sort(), [
    ['findByLastName', 'read', 'EXACT'],
    ['save', 'write', 'EXACT'],
  ]);

  const ei = callTool('endpoint_impact', { column: 'owners.last_name', mode: 'conservative' }, ctx);
  assert.deepEqual(ei.answer.endpoints.map((e) => [e.id, e.grade]).sort(), [
    ['GET /owners', 'SOUND_SET'],
    ['POST /owners', 'SOUND_SET'],
  ]);
  // The weakest link is the controller -> repository CALL, not the mapping.
  assert.equal(ei.answer.endpoints.every((e) => e.grade === 'SOUND_SET'), true);
});

test('with no naming strategy declared the same chain is HEURISTIC, and conservative mode says so', () => {
  const facts = withService();
  const g = G();
  addJavaFacts(g, facts);
  addJpaFacts(g, facts); // strategy UNDECLARED
  const ctx = {
    graph: g,
    basis: { project: 'x', buildDigest: 'd', builtAt: null, freshness: { verdict: 'unknown' } },
    trust: computeTrust({}), limits: [], pack: { axes: null, laneStats: null }, profile: null,
  };
  const strict = callTool('endpoint_impact', { column: 'owners.last_name', mode: 'conservative' }, ctx);
  assert.deepEqual(strict.answer.endpoints, [], 'a derived name is below the conservative floor');
  const wide = callTool('endpoint_impact', { column: 'owners.last_name', mode: 'heuristic' }, ctx);
  assert.deepEqual(wide.answer.endpoints.map((e) => [e.id, e.grade]), [['POST /owners', 'HEURISTIC']]);
});

test('addJpaFacts is a no-op on a pack with no entity or repository fact', () => {
  const g = G();
  const stats = addJpaFacts(g, [{ kind: 'type', fqn: `${P}.X`, typeKind: 'class', package: P, annotations: [], implements: [] }]);
  assert.equal(g.nodes.size, 0);
  assert.equal(stats.entities, 0);
  assert.equal(stats.statements, 0);
});

test('an unknown naming strategy is refused, not silently defaulted', () => {
  assert.throws(() => addJpaFacts(G(), shopFacts(), { namingStrategy: 'kebab' }), /namingStrategy/);
});
