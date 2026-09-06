// jpql_lite.test.mjs — what the small JPQL reader can classify, and what it says
// when it cannot.
//
// The expectations are written from the JPQL the queries themselves contain
// (which alias is bound to which entity, which paths are read, which are
// written), not from the reader's output. The point of the last few cases is the
// honest half: a subquery, an unreadable clause and a constructor expression
// must come back with a DIAGNOSTIC and the identifiers they did resolve — never
// as a clean empty answer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readJpql, tokenize } from '../src/core/jpql_lite.mjs';

const refs = (list) => list.map((r) => (r.path.length ? `${r.alias}.${r.path.join('.')}` : r.alias)).sort();
const reasons = (r) => [...new Set(r.diagnostics.map((d) => d.reason))].sort();

test('SELECT of a whole alias binds the root and reads the alias itself', () => {
  const r = readJpql('SELECT o FROM Owner o');
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'select');
  assert.deepEqual(r.roots, [{ entity: 'Owner', alias: 'o' }]);
  assert.deepEqual(refs(r.reads), ['o']);
  assert.deepEqual(r.diagnostics, []);
});

test('petclinic PetTypeRepository.findPetTypes, verbatim', () => {
  const r = readJpql('SELECT ptype FROM PetType ptype ORDER BY ptype.name');
  assert.equal(r.ok, true);
  assert.deepEqual(r.roots, [{ entity: 'PetType', alias: 'ptype' }]);
  assert.deepEqual(refs(r.reads), ['ptype', 'ptype.name']);
  assert.deepEqual(r.diagnostics, []);
});

test('AS before the alias, and a fully-qualified entity name, are both accepted', () => {
  const r = readJpql('SELECT o FROM com.example.Owner AS o WHERE o.city = :city');
  assert.deepEqual(r.roots, [{ entity: 'Owner', alias: 'o' }]);
  assert.deepEqual(refs(r.reads), ['o', 'o.city']);
});

test('SELECT of attributes reads exactly those paths', () => {
  const r = readJpql('SELECT o.firstName, o.lastName FROM Owner o');
  assert.deepEqual(refs(r.reads), ['o.firstName', 'o.lastName']);
});

test('DISTINCT is a keyword, not an alias', () => {
  const r = readJpql('SELECT DISTINCT o FROM Owner o');
  assert.deepEqual(refs(r.reads), ['o']);
});

test('a JOIN along an association binds the second alias', () => {
  const r = readJpql('SELECT p FROM Pet p JOIN p.owner o WHERE o.lastName = :n');
  assert.equal(r.ok, true);
  assert.deepEqual(r.joins, [{ base: 'p', path: ['owner'], alias: 'o', fetch: false, type: 'inner' }]);
  assert.deepEqual(refs(r.reads), ['o.lastName', 'p']);
});

test('LEFT JOIN FETCH is read as a join, and marked as a fetch', () => {
  const r = readJpql('SELECT o FROM Owner o LEFT JOIN FETCH o.pets p');
  assert.deepEqual(r.joins, [{ base: 'o', path: ['pets'], alias: 'p', fetch: true, type: 'left' }]);
});

test('LEFT OUTER JOIN and INNER JOIN parse the same way', () => {
  assert.deepEqual(readJpql('SELECT o FROM Owner o LEFT OUTER JOIN o.pets p').joins[0].type, 'left');
  assert.deepEqual(readJpql('SELECT o FROM Owner o INNER JOIN o.pets p').joins[0].type, 'inner');
});

test('several joins in a row, including a nested association path', () => {
  const r = readJpql('SELECT v FROM Visit v JOIN v.pet p JOIN p.owner o LEFT JOIN FETCH p.type t');
  assert.deepEqual(r.joins.map((j) => [j.base, j.path.join('.'), j.alias, j.fetch]), [
    ['v', 'pet', 'p', false], ['p', 'owner', 'o', false], ['p', 'type', 't', true],
  ]);
});

test('a join with no alias is still a join', () => {
  const r = readJpql('SELECT o FROM Owner o JOIN o.pets WHERE o.city = :c');
  assert.deepEqual(r.joins, [{ base: 'o', path: ['pets'], alias: null, fetch: false, type: 'inner' }]);
});

test('a JOIN … ON is read, and the ON clause contributes reads', () => {
  const r = readJpql('SELECT o FROM Owner o JOIN o.pets p ON p.name = :n');
  assert.deepEqual(r.joins.length, 1);
  assert.ok(refs(r.reads).includes('p.name'));
});

test('WHERE with named and positional parameters: the params are not references', () => {
  const r = readJpql('SELECT o FROM Owner o WHERE o.lastName = :name AND o.city = ?1');
  assert.deepEqual(refs(r.reads), ['o', 'o.city', 'o.lastName']);
});

test('a function call is not a reference, but its arguments are', () => {
  const r = readJpql('SELECT COUNT(o) FROM Owner o WHERE LOWER(o.lastName) LIKE :n');
  assert.deepEqual(refs(r.reads), ['o', 'o.lastName']);
});

test('arithmetic and comparison operators do not stop the scan', () => {
  const r = readJpql('SELECT p FROM Pet p WHERE p.birthDate <= :d AND p.id + 1 > 0');
  assert.deepEqual(refs(r.reads), ['p', 'p.birthDate', 'p.id']);
});

test('GROUP BY / HAVING / ORDER BY all contribute reads', () => {
  const r = readJpql('SELECT o.city FROM Owner o GROUP BY o.city HAVING COUNT(o) > 1 ORDER BY o.city DESC');
  assert.deepEqual(refs(r.reads), ['o', 'o.city']);
});

test('a comma-separated FROM binds both roots', () => {
  const r = readJpql('SELECT o, p FROM Owner o, Pet p WHERE p.name = o.city');
  assert.deepEqual(r.roots, [{ entity: 'Owner', alias: 'o' }, { entity: 'Pet', alias: 'p' }]);
  assert.deepEqual(refs(r.reads), ['o', 'o.city', 'p', 'p.name']);
});

test('a constructor expression: the attributes resolve, the DTO class is not a reference', () => {
  const r = readJpql('SELECT new com.example.OwnerDto(o.id, o.lastName) FROM Owner o');
  assert.equal(r.ok, true);
  assert.deepEqual(refs(r.reads), ['o.id', 'o.lastName']);
  assert.equal(r.reads.some((x) => x.alias.includes('Dto')), false, 'the DTO class must not be read as an alias');
});

test('UPDATE: the SET targets are WRITES, everything else is a read', () => {
  const r = readJpql('UPDATE Owner o SET o.city = :city, o.telephone = :tel WHERE o.id = :id');
  assert.equal(r.kind, 'update');
  assert.deepEqual(r.roots, [{ entity: 'Owner', alias: 'o' }]);
  assert.deepEqual(refs(r.writes), ['o.city', 'o.telephone']);
  assert.deepEqual(refs(r.reads), ['o.id']);
});

test('UPDATE whose right-hand side reads another column', () => {
  const r = readJpql('UPDATE Pet p SET p.name = p.type WHERE p.id = ?1');
  assert.deepEqual(refs(r.writes), ['p.name']);
  assert.deepEqual(refs(r.reads), ['p.id', 'p.type']);
});

test('UPDATE with no alias uses the entity name as the alias', () => {
  const r = readJpql('UPDATE Owner SET Owner.city = :c');
  assert.deepEqual(r.roots, [{ entity: 'Owner', alias: 'Owner' }]);
  assert.deepEqual(refs(r.writes), ['Owner.city']);
});

test('DELETE FROM with and without an alias', () => {
  const a = readJpql('DELETE FROM Visit v WHERE v.date < :d');
  assert.equal(a.kind, 'delete');
  assert.deepEqual(a.roots, [{ entity: 'Visit', alias: 'v' }]);
  assert.deepEqual(refs(a.reads), ['v.date']);
  const b = readJpql('DELETE FROM Visit');
  assert.deepEqual(b.roots, [{ entity: 'Visit', alias: 'Visit' }]);
});

test('a subquery is REPORTED, and the identifiers it holds are still collected', () => {
  const r = readJpql('SELECT o FROM Owner o WHERE o.id IN (SELECT p.owner.id FROM Pet p)');
  assert.equal(r.ok, true, 'the statement is kept');
  assert.deepEqual(reasons(r), ['subquery']);
  assert.ok(refs(r.reads).includes('o.id'));
  assert.ok(refs(r.reads).includes('p.owner.id'), 'an identifier inside the subquery still resolves');
});

test('a JOIN that does not walk an association is reported, not silently modelled', () => {
  const r = readJpql('SELECT o FROM Owner o JOIN Pet p ON p.name = :n');
  assert.deepEqual(reasons(r), ['join-not-an-association']);
});

test('a statement that is not SELECT/UPDATE/DELETE is refused with a reason', () => {
  const r = readJpql('MERGE INTO owners VALUES (1)');
  assert.equal(r.ok, false);
  assert.deepEqual(reasons(r), ['unknown-statement']);
});

test('empty and whitespace-only queries are refused, never read as "touches nothing"', () => {
  for (const q of ['', '   ', null, undefined]) {
    const r = readJpql(q);
    assert.equal(r.ok, false);
    assert.deepEqual(reasons(r), ['empty-query']);
  }
});

test('a SELECT with no FROM is refused with a reason', () => {
  const r = readJpql('SELECT o');
  assert.equal(r.ok, false);
  assert.deepEqual(reasons(r), ['no-from']);
});

test('an UPDATE with no SET is refused with a reason', () => {
  const r = readJpql('UPDATE Owner o WHERE o.id = 1');
  assert.equal(r.ok, false);
  assert.deepEqual(reasons(r), ['no-set']);
});

test('the tokenizer keeps a dotted identifier whole and a string literal opaque', () => {
  const toks = tokenize("SELECT o.lastName FROM Owner o WHERE o.city = 'Ma''drid'");
  assert.deepEqual(toks[1], { text: 'o.lastName', kind: 'ident' });
  assert.equal(toks[toks.length - 1].kind, 'string');
  assert.equal(toks[toks.length - 1].text, "'Ma''drid'");
});
