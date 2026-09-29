// jpa_review4.test.mjs — what the JPA bridge assumed and stated as a fact
// (RM67 review 4, "Java · JPA": J-1, J-5, J-6, and design 4).
//
// Each case is real Java run through the real worker, then the Java and JPA
// bridges, because the defects were in what a mapping leaves UNSAID:
//   * a key the tree never declares (an @Id in a library superclass) was read
//     as `id` and graded EXACT, on the JOINED subclass's table too (J-1);
//   * a foreign key toward a composite key was named `<attribute>_id`, a column
//     that does not exist, and with @IdClass one key column was dropped (J-5);
//   * a map key, an order column and a SINGLE_TABLE discriminator are columns of
//     the row that nothing drew and nothing said (J-6);
//   * an annotation the bridge does not know was read past as if it changed
//     nothing (design 1: "changes nothing" is judged only for the ones it knows).
// Design 4: a conclusion that rests on a default is HEURISTIC and says
// "assumed default".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findJdk } from '../scripts/ci-java-smoke.mjs';
import { Graph } from '../src/core/graph.mjs';
import { addJavaFacts } from '../src/adapters/java_bridge.mjs';
import { addJpaFacts } from '../src/adapters/jpa_bridge.mjs';

const ENGINE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const SKIP = 'no JDK found: JAVA_HOME is unset and no javac on PATH, see docs/setup/java-lane.md';
const J = 'package p; import javax.persistence.*; import java.util.*; import org.springframework.data.jpa.repository.*;';

let built = null;
/** The worker, compiled once for this file; null without a JDK. */
function worker(t) {
  const jdk = findJdk();
  if (!jdk) return null;
  if (built === null) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-jpa-r4-cls-'));
    execFileSync(jdk.javac, ['-d', dir, path.join(ENGINE_ROOT, 'adapters', 'java', 'JavaFacts.java')], { stdio: ['ignore', 'ignore', 'inherit'] });
    built = { jdk, dir };
  }
  void t;
  return built;
}

/** Run the worker over `sources`, then both bridges: the SQL-ish edges as lines, and the JPA stats. */
function jpaRun(t, sources, { namingStrategy = null } = {}) {
  const w = worker(t);
  if (!w) return null;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-jpa-r4-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, src] of Object.entries(sources)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), src);
  }
  const facts = execFileSync(w.jdk.java, ['-cp', w.dir, 'JavaFacts', '--root', root, root], { maxBuffer: 1 << 26 })
    .toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const g = new Graph();
  addJavaFacts(g, facts, {});
  const stats = addJpaFacts(g, facts, { namingStrategy });
  const sql = g.edges.filter((e) => ['EXECUTES', 'READS', 'WRITES', 'JOINS'].includes(e.type))
    .map((e) => `${e.from.replace(/^statement:[\w.]*\./, '')} ${e.type} ${e.to} ${e.grade}`);
  return { g, stats, sql };
}
const notes = (r) => r.stats.unresolved.map((u) => `${u.reason}: ${u.detail ?? ''}`);

test('joined_key_column_is_not_exact_when_the_primary_key_is_not_read', (t) => {
  const r = jpaRun(t, {
    'p/Animal.java': `${J} @Entity @Table(name="animals") @Inheritance(strategy=InheritanceType.JOINED) public class Animal extends lib.AbstractPersistable<Long> { @Column(name="name") String name; }`,
    'p/Dog.java': `${J} @Entity @Table(name="dogs") public class Dog extends Animal { @Column(name="bark") String bark; }`,
    'p/DogRepository.java': `${J} public interface DogRepository extends JpaRepository<Dog, Long> { List<Dog> findAll(); }`,
  });
  if (!r) { t.skip(SKIP); return; }
  const idEdges = r.sql.filter((s) => s.includes('column:dogs.id') || s.includes('JOINS table:dogs'));
  assert.ok(idEdges.length > 0, 'the joined key is still drawn');
  assert.ok(idEdges.every((s) => !/ EXACT$/.test(s)), idEdges.join('\n'));
  assert.ok(notes(r).some((n) => /p\.Animal/.test(n) && /assumed default/.test(n)), `the assumed key is said: ${notes(r).join('\n')}`);
});

test('a key the tree declares is still EXACT on the joined subclass, and nothing is said about it', (t) => {
  const r = jpaRun(t, {
    'p/Animal.java': `${J} @Entity @Table(name="animals") @Inheritance(strategy=InheritanceType.JOINED) public class Animal { @Id @Column(name="animal_id") Long id; @Column(name="name") String name; }`,
    'p/Dog.java': `${J} @Entity @Table(name="dogs") public class Dog extends Animal { @Column(name="bark") String bark; }`,
    'p/DogRepository.java': `${J} public interface DogRepository extends JpaRepository<Dog, Long> { List<Dog> findAll(); }`,
  });
  if (!r) { t.skip(SKIP); return; }
  assert.ok(r.sql.includes('findAll READS column:dogs.animal_id EXACT'), r.sql.join('\n'));
  assert.ok(r.sql.includes('table:animals JOINS table:dogs EXACT'), r.sql.join('\n'));
  assert.ok(!notes(r).some((n) => /assumed default/.test(n)), notes(r).join('\n'));
});

test('jpa_default_join_column_to_composite_key_is_not_exact', (t) => {
  const r = jpaRun(t, {
    'p/OwnerKey.java': `${J} @Embeddable public class OwnerKey { @Column(name="org") String org; @Column(name="num") Long num; }`,
    'p/Owner.java': `${J} @Entity @Table(name="owners") public class Owner { @EmbeddedId OwnerKey key; @ManyToMany(fetch=FetchType.EAGER) Set<Tag> tags; }`,
    'p/Tag.java': `${J} @Entity @Table(name="tags") public class Tag { @Id @Column(name="id") Long id; }`,
    'p/Pet.java': `${J} @Entity @Table(name="pets") public class Pet { @Id @Column(name="id") Long id; @ManyToOne Owner owner; }`,
    'p/PetRepository.java': `${J} public interface PetRepository extends JpaRepository<Pet, Long> { List<Pet> findAll(); }`,
    'p/OwnerRepository.java': `${J} public interface OwnerRepository extends JpaRepository<Owner, OwnerKey> { List<Owner> findAll(); }`,
  }, { namingStrategy: 'spring-snake-case' });
  if (!r) { t.skip(SKIP); return; }
  const bad = r.sql.filter((s) => /column:(pets|owners_tags)\.owner_id /.test(s));
  assert.deepEqual(bad, [], 'owner_id does not exist: the key is (org, num)');
  // JPA 2.10.x: one foreign key column per key column, `<attribute>_<key column>`.
  for (const c of ['pets.owner_org', 'pets.owner_num']) assert.ok(r.sql.includes(`findAll READS column:${c} EXACT`), `${c}\n${r.sql.join('\n')}`);
  for (const c of ['owners_tags.owner_org', 'owners_tags.owner_num']) assert.ok(r.sql.some((s) => s.includes(`READS column:${c} `)), `${c}\n${r.sql.join('\n')}`);
  // The owner's own key columns are the embeddable's.
  assert.ok(r.sql.includes('findAll READS column:owners.org EXACT'), r.sql.join('\n'));
});

test('an @IdClass key keeps every key column on the foreign key, none dropped', (t) => {
  const r = jpaRun(t, {
    'p/Owner.java': `${J} @Entity @Table(name="owners") @IdClass(OwnerKey.class) public class Owner { @Id @Column(name="org") String org; @Id @Column(name="num") Long num; }`,
    'p/OwnerKey.java': `${J} public class OwnerKey { String org; Long num; }`,
    'p/Pet.java': `${J} @Entity @Table(name="pets") public class Pet { @Id @Column(name="id") Long id; @ManyToOne Owner owner; }`,
    'p/PetRepository.java': `${J} public interface PetRepository extends JpaRepository<Pet, Long> { List<Pet> findAll(); }`,
  }, { namingStrategy: 'spring-snake-case' });
  if (!r) { t.skip(SKIP); return; }
  for (const c of ['pets.owner_org', 'pets.owner_num']) assert.ok(r.sql.includes(`findAll READS column:${c} EXACT`), `${c}\n${r.sql.join('\n')}`);
});

test('jpa_map_key_and_order_columns_are_said', (t) => {
  const r = jpaRun(t, {
    'p/Owner.java': `${J} @Entity @Table(name="owners") public class Owner { @Id @Column(name="id") Long id; @OneToMany(fetch=FetchType.EAGER) @JoinColumn(name="owner_id") @MapKeyJoinColumn(name="kind_id") Map<Kind, Pet> pets; @OneToMany(fetch=FetchType.EAGER) @JoinColumn(name="owner_id") @OrderColumn(name="pos") List<Visit> visits; }`,
    'p/Kind.java': `${J} @Entity @Table(name="kinds") public class Kind { @Id @Column(name="id") Long id; }`,
    'p/Pet.java': `${J} @Entity @Table(name="pets") public class Pet { @Id @Column(name="id") Long id; }`,
    'p/Visit.java': `${J} @Entity @Table(name="visits") public class Visit { @Id @Column(name="id") Long id; }`,
    'p/OwnerRepository.java': `${J} public interface OwnerRepository extends JpaRepository<Owner, Long> { Optional<Owner> findById(Long id); }`,
  }, { namingStrategy: 'spring-snake-case' });
  if (!r) { t.skip(SKIP); return; }
  const drawn = r.sql.some((s) => /pets\.kind_id|visits\.pos/.test(s));
  const said = JSON.stringify(r.stats.unresolved ?? []).match(/MapKeyJoinColumn|OrderColumn/);
  assert.ok(drawn || said, 'the map key and order columns are neither drawn nor said');
  const n = notes(r);
  assert.ok(n.some((x) => /Owner\.pets/.test(x) && /MapKeyJoinColumn/.test(x)), n.join('\n'));
  assert.ok(n.some((x) => /Owner\.visits/.test(x) && /OrderColumn/.test(x)), n.join('\n'));
});

test('a SINGLE_TABLE hierarchy reads and writes its discriminator: the default is drawn and said as assumed', (t) => {
  const r = jpaRun(t, {
    'p/Animal.java': `${J} @Entity @Table(name="animals") public class Animal { @Id @Column(name="id") Long id; @Column(name="name") String name; }`,
    'p/Mammal.java': `${J} @Entity @Table(name="mammals") public class Mammal extends Animal { @Column(name="fur") String fur; }`,
    'p/Dog.java': `${J} @Entity public class Dog extends Mammal { @Column(name="bark") String bark; }`,
    'p/DogRepository.java': `${J} public interface DogRepository extends JpaRepository<Dog, Long> { List<Dog> findByFur(String f); }`,
    'p/Svc.java': `${J} class Svc { DogRepository r; void s(Dog d){ r.save(d); } }`,
  }, { namingStrategy: 'spring-snake-case' });
  if (!r) { t.skip(SKIP); return; }
  assert.ok(r.sql.includes('findByFur READS column:animals.dtype HEURISTIC'), r.sql.join('\n'));
  assert.ok(r.sql.includes('save WRITES column:animals.dtype HEURISTIC'), r.sql.join('\n'));
  assert.ok(notes(r).some((n) => /discriminator/.test(n) && /assumed default/.test(n)), notes(r).join('\n'));
});

test('a declared @DiscriminatorColumn is a column this lane does not name: said, not guessed', (t) => {
  const r = jpaRun(t, {
    'p/Animal.java': `${J} @Entity @Table(name="animals") @DiscriminatorColumn(name="kind") public class Animal { @Id @Column(name="id") Long id; }`,
    'p/Dog.java': `${J} @Entity public class Dog extends Animal { @Column(name="bark") String bark; }`,
    'p/DogRepository.java': `${J} public interface DogRepository extends JpaRepository<Dog, Long> { List<Dog> findByBark(String b); }`,
  }, { namingStrategy: 'spring-snake-case' });
  if (!r) { t.skip(SKIP); return; }
  assert.ok(!r.sql.some((s) => /animals\.dtype/.test(s)), 'the default is not drawn when a column is declared');
  assert.ok(notes(r).some((n) => /DiscriminatorColumn/.test(n)), notes(r).join('\n'));
});

test('an attribute annotation this lane does not know is said, and its column is not stated as known', (t) => {
  const r = jpaRun(t, {
    'p/Owner.java': `${J} @Entity @Table(name="owners") public class Owner { @Id @Column(name="id") Long id; @Column(name="nick") @javax.validation.constraints.NotBlank @com.fasterxml.jackson.annotation.JsonIgnore String nick; @Column(name="secret") @x.Mystery String secret; }`,
    'p/OwnerRepository.java': `${J} public interface OwnerRepository extends JpaRepository<Owner, Long> { List<Owner> findAll(); }`,
  }, { namingStrategy: 'spring-snake-case' });
  if (!r) { t.skip(SKIP); return; }
  assert.ok(r.sql.includes('findAll READS column:owners.nick EXACT'), 'a validation or JSON annotation changes nothing about the column');
  assert.ok(r.sql.includes('findAll READS column:owners.secret HEURISTIC'), r.sql.join('\n'));
  assert.ok(notes(r).some((n) => /Owner\.secret/.test(n) && /@Mystery/.test(n)), notes(r).join('\n'));
});

test('an entity whose key the tree never declares: every column that rests on it is an assumed default', (t) => {
  const r = jpaRun(t, {
    'p/Owner.java': `${J} @Entity @Table(name="owners") public class Owner extends lib.BaseEntity { @Column(name="name") String name; }`,
    'p/Pet.java': `${J} @Entity @Table(name="pets") public class Pet { @Id @Column(name="id") Long id; @ManyToOne Owner owner; }`,
    'p/OwnerRepository.java': `${J} public interface OwnerRepository extends JpaRepository<Owner, Long> { }`,
    'p/PetRepository.java': `${J} public interface PetRepository extends JpaRepository<Pet, Long> { List<Pet> findAll(); }`,
    'p/Svc.java': `${J} class Svc { OwnerRepository o; void s(){ o.findById(1L); } }`,
  }, { namingStrategy: 'spring-snake-case' });
  if (!r) { t.skip(SKIP); return; }
  assert.ok(r.sql.includes('findById READS column:owners.id HEURISTIC'), r.sql.join('\n'));
  assert.ok(r.sql.includes('findAll READS column:pets.owner_id HEURISTIC'), r.sql.join('\n'));
  assert.ok(r.sql.includes('table:owners JOINS table:pets HEURISTIC'), r.sql.join('\n'));
  assert.ok(!r.sql.some((s) => /\.id EXACT$/.test(s) && /owners\./.test(s)), r.sql.join('\n'));
  assert.ok(notes(r).some((n) => /p\.Owner/.test(n) && /assumed default/.test(n)), notes(r).join('\n'));
});
