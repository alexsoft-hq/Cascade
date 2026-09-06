// derived_query.test.mjs — Spring Data's method-name grammar, case by case.
//
// The table below is written from the Spring Data JPA reference's "Query
// Creation" section, NOT from what this parser happens to return: every row is
// a name the framework documents (or a shape petclinic and the reference use)
// together with the property paths and operators the framework says it derives.
// A parser that agreed with itself would prove nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDerivedQuery, resolvePropertyPath, camelHeads, OPERATORS, SUBJECTS } from '../src/core/derived_query.mjs';

/** [methodName, {subject, access, distinct, limit, props:[[property, operator, ignoreCase]], order:[[prop,dir]]}] */
const TABLE = [
  // --- the plain subject keywords ------------------------------------------
  ['findByLastName', { subject: 'find', access: 'select', props: [['lastName', null, false]] }],
  ['readByLastName', { subject: 'read', access: 'select', props: [['lastName', null, false]] }],
  ['getByLastName', { subject: 'get', access: 'select', props: [['lastName', null, false]] }],
  ['queryByLastName', { subject: 'query', access: 'select', props: [['lastName', null, false]] }],
  ['searchByLastName', { subject: 'search', access: 'select', props: [['lastName', null, false]] }],
  ['streamByLastName', { subject: 'stream', access: 'select', props: [['lastName', null, false]] }],
  ['countByLastName', { subject: 'count', access: 'select', props: [['lastName', null, false]] }],
  ['existsByLastName', { subject: 'exists', access: 'select', props: [['lastName', null, false]] }],
  ['deleteByLastName', { subject: 'delete', access: 'delete', props: [['lastName', null, false]] }],
  ['removeByLastName', { subject: 'remove', access: 'delete', props: [['lastName', null, false]] }],

  // --- no predicate at all --------------------------------------------------
  ['findAll', { subject: 'find', access: 'select', hasBy: false, props: [] }],
  ['deleteAll', { subject: 'delete', access: 'delete', hasBy: false, props: [] }],
  ['findAllByOrderByLastNameAsc', { subject: 'find', access: 'select', props: [], order: [['lastName', 'asc']] }],

  // --- subject decorations --------------------------------------------------
  ['findDistinctByLastName', { subject: 'find', distinct: true, props: [['lastName', null, false]] }],
  ['findDistinctPeopleByLastNameOrFirstName', {
    subject: 'find', distinct: true,
    props: [['lastName', null, false], ['firstName', null, false]],
  }],
  ['findFirstByLastName', { subject: 'find', limit: 1, props: [['lastName', null, false]] }],
  ['findTopByLastName', { subject: 'find', limit: 1, props: [['lastName', null, false]] }],
  ['findTop3ByLastNameOrderByFirstNameAsc', {
    subject: 'find', limit: 3, props: [['lastName', null, false]], order: [['firstName', 'asc']],
  }],
  ['findFirst10ByLastName', { subject: 'find', limit: 10, props: [['lastName', null, false]] }],

  // --- operators, as documented --------------------------------------------
  ['findByFirstNameIsLastName', { subject: 'find', props: [['firstNameIsLastName', null, false]] }],
  ['findByLastNameIs', { subject: 'find', props: [['lastName', 'Is', false]] }],
  ['findByLastNameEquals', { subject: 'find', props: [['lastName', 'Equals', false]] }],
  ['findByStartDateBetween', { subject: 'find', props: [['startDate', 'Between', false]] }],
  ['findByAgeLessThan', { subject: 'find', props: [['age', 'LessThan', false]] }],
  ['findByAgeLessThanEqual', { subject: 'find', props: [['age', 'LessThanEqual', false]] }],
  ['findByAgeGreaterThan', { subject: 'find', props: [['age', 'GreaterThan', false]] }],
  ['findByAgeGreaterThanEqual', { subject: 'find', props: [['age', 'GreaterThanEqual', false]] }],
  ['findByStartDateAfter', { subject: 'find', props: [['startDate', 'After', false]] }],
  ['findByStartDateBefore', { subject: 'find', props: [['startDate', 'Before', false]] }],
  ['findByAgeIsNull', { subject: 'find', props: [['age', 'IsNull', false]] }],
  ['findByAgeNull', { subject: 'find', props: [['age', 'Null', false]] }],
  ['findByAgeIsNotNull', { subject: 'find', props: [['age', 'IsNotNull', false]] }],
  ['findByAgeNotNull', { subject: 'find', props: [['age', 'NotNull', false]] }],
  ['findByFirstNameLike', { subject: 'find', props: [['firstName', 'Like', false]] }],
  ['findByFirstNameNotLike', { subject: 'find', props: [['firstName', 'NotLike', false]] }],
  ['findByFirstNameStartingWith', { subject: 'find', props: [['firstName', 'StartingWith', false]] }],
  ['findByFirstNameEndingWith', { subject: 'find', props: [['firstName', 'EndingWith', false]] }],
  ['findByFirstNameContaining', { subject: 'find', props: [['firstName', 'Containing', false]] }],
  ['findByLastNameNot', { subject: 'find', props: [['lastName', 'Not', false]] }],
  ['findByAgeIn', { subject: 'find', props: [['age', 'In', false]] }],
  ['findByAgeNotIn', { subject: 'find', props: [['age', 'NotIn', false]] }],
  ['findByActiveTrue', { subject: 'find', props: [['active', 'True', false]] }],
  ['findByActiveFalse', { subject: 'find', props: [['active', 'False', false]] }],
  ['findByFirstNameIgnoreCase', { subject: 'find', props: [['firstName', null, true]] }],
  ['findByFirstNameStartingWithIgnoreCase', { subject: 'find', props: [['firstName', 'StartingWith', true]] }],
  ['findByFirstNameAndLastNameAllIgnoreCase', {
    subject: 'find', props: [['firstName', null, false], ['lastName', null, true]],
  }],

  // --- connectors and ordering ---------------------------------------------
  ['findByLastNameAndFirstName', {
    subject: 'find', props: [['lastName', null, false], ['firstName', null, false]],
  }],
  ['findByLastNameOrFirstName', {
    subject: 'find', props: [['lastName', null, false], ['firstName', null, false]],
  }],
  ['findByLastNameOrderByFirstNameDesc', {
    subject: 'find', props: [['lastName', null, false]], order: [['firstName', 'desc']],
  }],
  ['findByLastNameOrderByLastNameDescFirstNameAsc', {
    subject: 'find', props: [['lastName', null, false]],
    order: [['lastName', 'desc'], ['firstName', 'asc']],
  }],
  ['findByLastNameOrderByFirstName', {
    subject: 'find', props: [['lastName', null, false]], order: [['firstName', 'asc']],
  }],

  // --- nested property paths (resolved separately, below) -------------------
  ['findByOwnerLastNameStartingWith', { subject: 'find', props: [['ownerLastName', 'StartingWith', false]] }],
  ['findByOwner_LastName', { subject: 'find', props: [['owner_LastName', null, false]] }],
  ['findByTypeNameAndOwnerCity', {
    subject: 'find', props: [['typeName', null, false], ['ownerCity', null, false]],
  }],
  // petclinic's own two, verbatim from OwnerRepository.java at the pinned commit
  ['findByLastNameStartingWith', { subject: 'find', props: [['lastName', 'StartingWith', false]] }],
  ['findById', { subject: 'find', props: [['id', null, false]] }],
];

test('the derived-query table: every documented name parses to its properties and operators', () => {
  assert.ok(TABLE.length >= 40, `the table must hold at least 40 names, has ${TABLE.length}`);
  for (const [name, want] of TABLE) {
    const got = parseDerivedQuery(name);
    assert.equal(got.ok, true, `${name} must parse: ${got.reason}`);
    assert.equal(got.subject, want.subject, `${name} subject`);
    if (want.access) assert.equal(got.access, want.access, `${name} access`);
    assert.equal(got.distinct, want.distinct === true, `${name} distinct`);
    assert.equal(got.limit, want.limit ?? null, `${name} limit`);
    if (want.hasBy !== undefined) assert.equal(got.hasBy, want.hasBy, `${name} hasBy`);
    assert.deepEqual(
      got.parts.map((p) => [p.property, p.operator, p.ignoreCase]),
      want.props,
      `${name} predicate`,
    );
    assert.deepEqual(
      got.orderBy.map((o) => [o.property, o.direction]),
      want.order ?? [],
      `${name} order`,
    );
  }
});

test('malformed names come back ok:false WITH a reason — never a silent empty predicate', () => {
  const bad = [
    ['fetchByLastName', /subject keyword/],
    ['finderByLastName', /subject keyword/],
    ['findByAndLastName', /empty part/],
    ['findByLastNameAnd', /dangling And\/Or/],
    ['findByLastNameOr', /dangling And\/Or/],
    ['findByIgnoreCase', /names no property/],
    ['findByOrLastName', /empty part/],
    ['findByLastNameAndAndFirstName', /empty part/],
    ['', /empty/],
  ];
  for (const [name, re] of bad) {
    const got = parseDerivedQuery(name);
    assert.equal(got.ok, false, `${JSON.stringify(name)} must not parse`);
    assert.match(got.reason, re, `${JSON.stringify(name)} reason`);
  }
});

test('the operator list is longest-first, so GreaterThanEqual never loses to GreaterThan', () => {
  for (let i = 1; i < OPERATORS.length; i += 1) {
    for (let j = 0; j < i; j += 1) {
      assert.equal(
        OPERATORS[i].endsWith(OPERATORS[j]) && OPERATORS[i].length > OPERATORS[j].length,
        false,
        `${OPERATORS[j]} is listed before its longer form ${OPERATORS[i]}`,
      );
    }
  }
  assert.deepEqual(SUBJECTS.includes('find'), true);
});

// ---------------------------------------------------------------------------
// property paths, against a model
// ---------------------------------------------------------------------------

// A tiny entity model in `com.example`, the way the bridge presents one.
const MODEL = {
  'com.example.Pet': {
    name: {}, birthDate: {},
    owner: { assoc: 'com.example.Owner' },
    type: { assoc: 'com.example.PetType' },
  },
  'com.example.Owner': { lastName: {}, firstName: {}, city: {}, ownerLast: {} },
  'com.example.PetType': { name: {} },
};
const lookup = (entity, prop) => {
  const attrs = MODEL[entity];
  if (!attrs || !Object.hasOwn(attrs, prop)) return null;
  const a = attrs[prop];
  return { attribute: a, ...(a.assoc ? { associationTo: a.assoc } : {}) };
};

test('resolvePropertyPath walks an association: ownerLastName -> owner.lastName', () => {
  const r = resolvePropertyPath('ownerLastName', 'com.example.Pet', lookup);
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.path.map((p) => [p.entity, p.property]), [
    ['com.example.Pet', 'owner'],
    ['com.example.Owner', 'lastName'],
  ]);
});

test('resolvePropertyPath prefers a real attribute over the nested reading', () => {
  // `ownerLast` IS an attribute of Owner, so on Pet the split is owner + last…
  // but on Owner itself the WHOLE token wins, which is the documented rule.
  const own = resolvePropertyPath('ownerLast', 'com.example.Owner', lookup);
  assert.equal(own.ok, true);
  assert.deepEqual(own.path.map((p) => p.property), ['ownerLast']);
});

test('resolvePropertyPath honours the explicit `_` separator', () => {
  const r = resolvePropertyPath('owner_lastName', 'com.example.Pet', lookup);
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.path.map((p) => p.property), ['owner', 'lastName']);
});

test('resolvePropertyPath refuses to invent: an unknown name is ok:false with the reason', () => {
  const r = resolvePropertyPath('ownerNickname', 'com.example.Pet', lookup);
  assert.equal(r.ok, false);
  assert.match(r.reason, /no property path ownerNickname/);
  const leaf = resolvePropertyPath('nameSomething', 'com.example.Pet', lookup);
  assert.equal(leaf.ok, false, 'a leaf attribute cannot carry a nested path');
});

test('camelHeads is longest-first, which is what makes the greedy split correct', () => {
  assert.deepEqual(camelHeads('ownerLastName'), ['ownerLastName', 'ownerLast', 'owner']);
  assert.deepEqual(camelHeads('name'), ['name']);
});
