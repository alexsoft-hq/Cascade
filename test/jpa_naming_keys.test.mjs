// jpa_naming_keys.test.mjs — JPA names the source writes, composite keys, and annotations that cannot change a mapping (RM67-J5).
//
// Each case is real Java run through the real worker, then the Java and JPA
// bridges, because each defect was in how a mapping is READ:
//   * a written name was used verbatim and graded EXACT, but Hibernate hands a
//     written name to the physical naming strategy too, so Spring Boot's default
//     turns `@JoinColumn(name = "createdBy")` into `created_by` (defect 1);
//   * @JoinColumns and @MapsId were not read, so a foreign key toward a
//     composite key got the default names `<attribute>_<key column>` (defect 2);
//   * an @Embeddable field inside an @EmbeddedId became one column named after
//     the field (`posts_id`) instead of the nested type's own columns (defect 3);
//   * a project's own marker annotation, which Hibernate cannot read, made its
//     column a guess (defect 4).
// The egov-msa-edu shape (Posts, PostsId, Comment, CommentId, User) is checked
// against the column list its own DDL declares for `comment`.

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
function worker() {
  const jdk = findJdk();
  if (!jdk) return null;
  if (built === null) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-jpa-j5-cls-'));
    execFileSync(jdk.javac, ['-d', dir, path.join(ENGINE_ROOT, 'adapters', 'java', 'JavaFacts.java')], { stdio: ['ignore', 'ignore', 'inherit'] });
    built = { jdk, dir };
  }
  return built;
}

/** The worker's records for `sources`, or null without a JDK. */
function factsOf(t, sources) {
  const w = worker();
  if (!w) return null;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-jpa-j5-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, src] of Object.entries(sources)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), src);
  }
  return execFileSync(w.jdk.java, ['-cp', w.dir, 'JavaFacts', '--root', root, root], { maxBuffer: 1 << 26 })
    .toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** Both bridges over `sources`: the SQL-ish edges as lines, the JOINS pairs, the column ids, and the JPA stats. */
function jpaRun(t, sources, { namingStrategy = null, identifierCase = 'exact', facts = null } = {}) {
  const records = facts ?? factsOf(t, sources);
  if (!records) return null;
  const g = new Graph();
  addJavaFacts(g, records, {});
  const stats = addJpaFacts(g, records, { namingStrategy, identifierCase });
  const sql = g.edges.filter((e) => ['EXECUTES', 'READS', 'WRITES', 'JOINS'].includes(e.type))
    .map((e) => `${e.from.replace(/^statement:[\w.]*\./, '')} ${e.type} ${e.to} ${e.grade}`);
  const joins = g.edges.filter((e) => e.type === 'JOINS').map((e) => `${(e.evidence?.columns ?? []).join(',')} ${e.grade}`);
  const columns = (table) => [...g.nodes.keys()].filter((id) => id.startsWith(`column:${table}.`)).map((id) => id.slice(`column:${table}.`.length)).sort();
  return { g, stats, sql, joins, columns, records };
}
const notes = (r) => r.stats.unresolved.map((u) => `${u.reason}: ${u.detail ?? ''}`);
const has = (r, line) => assert.ok(r.sql.includes(line), `${line}\n${r.sql.join('\n')}`);

// ---------------------------------------------------------------------------
// egov-msa-edu's board service, as its source writes it
// ---------------------------------------------------------------------------

const EGOV = {
  'p/BaseTimeEntity.java': `${J} @MappedSuperclass public abstract class BaseTimeEntity { @org.springframework.data.annotation.CreatedDate java.time.LocalDateTime createdDate; @org.springframework.data.annotation.LastModifiedDate java.time.LocalDateTime modifiedDate; }`,
  'p/BaseEntity.java': `${J} @MappedSuperclass public abstract class BaseEntity extends BaseTimeEntity { @org.springframework.data.annotation.CreatedBy @Column(updatable = false) String createdBy; @org.springframework.data.annotation.LastModifiedBy String lastModifiedBy; }`,
  'p/User.java': `${J} @Entity public class User extends BaseEntity { @Id @Column(name = "user_no", insertable = false, updatable = false) Long id; @Column(insertable = false, updatable = false) String userId; @Column(insertable = false, updatable = false) String userName; }`,
  'p/Board.java': `${J} @Entity public class Board extends BaseEntity { @Id @GeneratedValue(strategy = GenerationType.IDENTITY) Integer boardNo; @Column(nullable = false, length = 100) String boardName; }`,
  'p/PostsId.java': `${J} @Embeddable public class PostsId implements java.io.Serializable { @Column(columnDefinition = "int(9)") Integer boardNo; @Column(columnDefinition = "int(9)") Integer postsNo; }`,
  'p/Posts.java': `${J} @Entity public class Posts extends BaseEntity { @EmbeddedId PostsId postsId;
    @MapsId("boardNo") @ManyToOne(fetch = FetchType.LAZY) @JoinColumn(name = "board_no") Board board;
    @Column(nullable = false, length = 100) String postsTitle;
    @ManyToOne(fetch = FetchType.LAZY) @JoinColumn(name = "createdBy", referencedColumnName = "userId", insertable = false, updatable = false) User creator;
    @OneToMany(mappedBy = "posts", fetch = FetchType.LAZY) List<Comment> comments; }`,
  'p/CommentId.java': `${J} @Embeddable public class CommentId implements java.io.Serializable { private PostsId postsId; @Column(columnDefinition = "int(9)") Integer commentNo; }`,
  'p/Comment.java': `${J} @Entity public class Comment extends BaseEntity { @EmbeddedId CommentId commentId;
    @Column(nullable = false, length = 2000) String commentContent; @Column(columnDefinition = "int(9)") Integer groupNo;
    @Column(columnDefinition = "int(9)") Integer parentCommentNo; @Column(nullable = false, columnDefinition = "smallint(3)") Integer depthSeq;
    @Column(nullable = false, columnDefinition = "int(9)") Integer sortSeq; @Column(nullable = false, columnDefinition = "tinyint(1) default '0'") Integer deleteAt;
    @ManyToOne(fetch = FetchType.LAZY) @JoinColumn(name = "createdBy", referencedColumnName = "userId", insertable = false, updatable = false) User creator;
    @MapsId("postsId") @ManyToOne(fetch = FetchType.LAZY) @JoinColumns({ @JoinColumn(name = "board_no"), @JoinColumn(name = "posts_no") }) Posts posts; }`,
  'p/CommentRepository.java': `${J} public interface CommentRepository extends JpaRepository<Comment, CommentId> { List<Comment> findAll(); }`,
};

/** CREATE TABLE `comment` in egov-msa-edu's docker-compose/mysql/init/init.sql. */
const COMMENT_DDL = ['board_no', 'posts_no', 'comment_no', 'comment_content', 'group_no', 'parent_comment_no', 'depth_seq',
  'sort_seq', 'delete_at', 'created_by', 'created_date', 'last_modified_by', 'modified_date'].sort();

let egovFacts = null;
const egov = (t) => (egovFacts ??= factsOf(t, EGOV));

for (const namingStrategy of [null, 'spring-snake-case']) {
  test(`egov-msa-edu's comment table has the columns its DDL declares (naming ${namingStrategy ?? 'undeclared'})`, (t) => {
    const facts = egov(t);
    if (!facts) { t.skip(SKIP); return; }
    const r = jpaRun(t, null, { namingStrategy, identifierCase: 'fold-lower', facts });
    assert.deepEqual(r.columns('comment'), COMMENT_DDL);
    // Posts as the fixture maps it: the DDL's columns less the ones the fixture leaves out.
    assert.deepEqual(r.columns('posts'), ['board_no', 'created_by', 'created_date', 'last_modified_by', 'modified_date', 'posts_no', 'posts_title']);
  });
}

test('the written names in egov-msa-edu are graded by whether every naming strategy spells them alike', (t) => {
  const facts = egov(t);
  if (!facts) { t.skip(SKIP); return; }
  const r = jpaRun(t, null, { identifierCase: 'fold-lower', facts });
  // `createdBy` is spelled `created_by` by Spring Boot's strategies and `createdBy`
  // by the identity one: with none declared it is the assumed default's spelling.
  // (Every table here is named by the strategy too, so every column is a guess.)
  has(r, 'findAll READS column:comment.created_by HEURISTIC');
  assert.ok(notes(r).some((n) => /p\.Comment/.test(n) && /createdBy/.test(n) && /created_by/.test(n) && /assumed default naming/.test(n)), notes(r).join('\n'));
  assert.ok(!notes(r).some((n) => /board_no/.test(n) && /assumed default naming/.test(n)), 'board_no is spelled alike by every strategy');
  // The foreign key references `userId`, which is `user.user_id`, not the key `user_no`.
  assert.ok(r.joins.some((j) => /^comment\.created_by=user\.user_id /.test(j)), r.joins.join('\n'));
  const declared = jpaRun(t, null, { namingStrategy: 'spring-snake-case', identifierCase: 'fold-lower', facts });
  has(declared, 'findAll READS column:comment.created_by EXACT');
  has(declared, 'findAll READS column:comment.comment_no EXACT');
});

test('a composite foreign key paired by position is a guess, and says so; @MapsId gives the association no columns of its own', (t) => {
  const facts = egov(t);
  if (!facts) { t.skip(SKIP); return; }
  const r = jpaRun(t, null, { namingStrategy: 'spring-snake-case', identifierCase: 'fold-lower', facts });
  const toPosts = r.joins.find((j) => /comment\.board_no=posts\.board_no,comment\.posts_no=posts\.posts_no /.test(j));
  assert.ok(toPosts, r.joins.join('\n'));
  assert.match(toPosts, / HEURISTIC$/);
  assert.ok(notes(r).some((n) => /Comment\.posts/.test(n) && /referencedColumnName/.test(n)), notes(r).join('\n'));
  assert.ok(!notes(r).some((n) => /jpa-mapping-unread/.test(n) && /Comment\.posts/.test(n)), notes(r).join('\n'));
  // Posts' key is (board_no, posts_no), the part @MapsId("boardNo") maps is the board's key.
  assert.ok(r.joins.some((j) => /^board\.board_no=posts\.board_no EXACT$|^posts\.board_no=board\.board_no EXACT$/.test(j)), r.joins.join('\n'));
});

// ---------------------------------------------------------------------------
// defect 1: a written name goes through the physical naming strategy
// ---------------------------------------------------------------------------

const WRITTEN = {
  'p/Doc.java': `${J} @Entity @Table(name = "docs") public class Doc { @Id @Column(name = "doc_id") Long id;
    @Column(name = "createdBy") String creator; @Column(name = "address2Line") String addr;
    @ManyToOne @JoinColumn(name = "ownerRef") Owner owner;
    @ManyToMany(fetch = FetchType.EAGER) @JoinTable(name = "docTags", joinColumns = @JoinColumn(name = "docRef"), inverseJoinColumns = @JoinColumn(name = "tagRef")) Set<Tag> tags; }`,
  'p/Owner.java': `${J} @Entity @Table(name = "owners") public class Owner { @Id @Column(name = "id") Long id; }`,
  'p/Tag.java': `${J} @Entity @Table(name = "tags") public class Tag { @Id @Column(name = "id") Long id; }`,
  'p/DocRepository.java': `${J} public interface DocRepository extends JpaRepository<Doc, Long> { List<Doc> findAll(); }`,
};

/** Per strategy: the column each written name is, and its grade on findAll's READS. */
const SPELLED = {
  undeclared: { 'docs.doc_id': 'EXACT', 'docs.created_by': 'HEURISTIC', 'docs.address2line': 'HEURISTIC', 'docs.owner_ref': 'HEURISTIC', 'doc_tags.doc_ref': 'HEURISTIC', 'doc_tags.tag_ref': 'HEURISTIC' },
  'spring-snake-case': { 'docs.doc_id': 'EXACT', 'docs.created_by': 'EXACT', 'docs.address2line': 'HEURISTIC', 'docs.owner_ref': 'EXACT', 'doc_tags.doc_ref': 'EXACT', 'doc_tags.tag_ref': 'EXACT' },
  'snake-case-hibernate6': { 'docs.doc_id': 'EXACT', 'docs.created_by': 'EXACT', 'docs.address2line': 'EXACT', 'docs.owner_ref': 'EXACT', 'doc_tags.doc_ref': 'EXACT' },
  'snake-case-hibernate7': { 'docs.doc_id': 'EXACT', 'docs.created_by': 'EXACT', 'docs.address2_line': 'EXACT', 'docs.owner_ref': 'EXACT', 'doc_tags.doc_ref': 'EXACT' },
  identity: { 'docs.doc_id': 'EXACT', 'docs.createdBy': 'EXACT', 'docs.address2Line': 'EXACT', 'docs.ownerRef': 'EXACT', 'docTags.docRef': 'EXACT', 'docTags.tagRef': 'EXACT' },
};

let writtenFacts = null;
for (const [label, want] of Object.entries(SPELLED)) {
  test(`a written camelCase name is the ${label} strategy's spelling, graded by what is declared`, (t) => {
    const facts = (writtenFacts ??= factsOf(t, WRITTEN));
    if (!facts) { t.skip(SKIP); return; }
    const r = jpaRun(t, null, { namingStrategy: label === 'undeclared' ? null : label, facts });
    for (const [col, grade] of Object.entries(want)) has(r, `findAll READS column:${col} ${grade}`);
    const verbatim = ['createdBy', 'address2Line', 'ownerRef'].filter((c) => r.columns('docs').includes(c));
    assert.deepEqual(verbatim, label === 'identity' ? ['createdBy', 'address2Line', 'ownerRef'] : [], r.columns('docs').join(', '));
    const said = notes(r).filter((n) => /assumed default naming/.test(n));
    assert.equal(said.length > 0, label === 'undeclared', said.join('\n'));
  });
}

test('an upper-case written name is EXACT where identifiers fold, and the strategy\'s spelling where they do not', (t) => {
  const facts = factsOf(t, {
    'p/Perf.java': `${J} @Entity @Table(name = "PERF_TEST") public class Perf { @Id @Column(name = "ID") Long id; @Column(name = "TEST_NAME") String testName; }`,
    'p/PerfRepository.java': `${J} public interface PerfRepository extends JpaRepository<Perf, Long> { List<Perf> findAll(); }`,
  });
  if (!facts) { t.skip(SKIP); return; }
  const folded = jpaRun(t, null, { identifierCase: 'fold-lower', facts });
  has(folded, 'findAll READS column:PERF_TEST.TEST_NAME EXACT');
  has(folded, 'findAll EXECUTES table:PERF_TEST EXACT');
  const exact = jpaRun(t, null, { identifierCase: 'exact', facts });
  has(exact, 'findAll READS column:perf_test.test_name HEURISTIC');
});

test('a JOINED subclass\'s written key column goes through the strategy too', (t) => {
  const r = jpaRun(t, {
    'p/Animal.java': `${J} @Entity @Table(name = "animals") @Inheritance(strategy = InheritanceType.JOINED) public class Animal { @Id @Column(name = "id") Long id; }`,
    'p/Dog.java': `${J} @Entity @Table(name = "dogs") @PrimaryKeyJoinColumn(name = "animalRef") public class Dog extends Animal { @Column(name = "bark") String bark; }`,
    'p/DogRepository.java': `${J} public interface DogRepository extends JpaRepository<Dog, Long> { List<Dog> findAll(); }`,
  }, { namingStrategy: 'spring-snake-case' });
  if (!r) { t.skip(SKIP); return; }
  has(r, 'findAll READS column:dogs.animal_ref EXACT');
  assert.ok(!r.columns('dogs').includes('animalRef'), r.columns('dogs').join(', '));
});

// ---------------------------------------------------------------------------
// defect 2: @JoinColumns and @MapsId
// ---------------------------------------------------------------------------

const OWNER_KEY = {
  'p/OwnerKey.java': `${J} @Embeddable public class OwnerKey { @Column(name = "org") String org; @Column(name = "num") Long num; }`,
  'p/Owner.java': `${J} @Entity @Table(name = "owners") public class Owner { @EmbeddedId OwnerKey key; }`,
  'p/PetRepository.java': `${J} public interface PetRepository extends JpaRepository<Pet, Long> { List<Pet> findAll(); }`,
};

test('@JoinColumns with referencedColumnName: each written column, paired with the key column it names', (t) => {
  const r = jpaRun(t, {
    ...OWNER_KEY,
    'p/Pet.java': `${J} @Entity @Table(name = "pets") public class Pet { @Id @Column(name = "id") Long id;
      @ManyToOne @JoinColumns({ @JoinColumn(name = "o_num", referencedColumnName = "num"), @JoinColumn(name = "o_org", referencedColumnName = "org") }) Owner owner; }`,
  }, { namingStrategy: 'spring-snake-case' });
  if (!r) { t.skip(SKIP); return; }
  has(r, 'findAll READS column:pets.o_num EXACT');
  has(r, 'findAll READS column:pets.o_org EXACT');
  assert.deepEqual(r.columns('pets'), ['id', 'o_num', 'o_org']);
  assert.ok(r.joins.includes('pets.o_num=owners.num,pets.o_org=owners.org EXACT'), r.joins.join('\n'));
  assert.ok(!notes(r).some((n) => /Pet\.owner/.test(n)), notes(r).join('\n'));
});

test('@JoinColumns without referencedColumnName: the written columns, paired by position, which is a guess and said', (t) => {
  const r = jpaRun(t, {
    ...OWNER_KEY,
    'p/Pet.java': `${J} @Entity @Table(name = "pets") public class Pet { @Id @Column(name = "id") Long id;
      @ManyToOne @JoinColumns({ @JoinColumn(name = "o_org"), @JoinColumn(name = "o_num") }) Owner owner; }`,
  }, { namingStrategy: 'spring-snake-case' });
  if (!r) { t.skip(SKIP); return; }
  has(r, 'findAll READS column:pets.o_org EXACT');
  assert.deepEqual(r.columns('pets'), ['id', 'o_num', 'o_org']);
  assert.ok(r.joins.includes('pets.o_org=owners.org,pets.o_num=owners.num HEURISTIC'), r.joins.join('\n'));
  assert.ok(notes(r).some((n) => /Pet\.owner/.test(n) && /position/.test(n)), notes(r).join('\n'));
});

const USERS = {
  'p/User.java': `${J} @Entity @Table(name = "users") public class User { @Id @Column(name = "id") Long id; }`,
  'p/ProfileRepository.java': `${J} public interface ProfileRepository extends JpaRepository<Profile, Long> { List<Profile> findAll(); }`,
};

test('an empty @MapsId with a written join column: that column is the key, and the association has no column of its own', (t) => {
  const r = jpaRun(t, {
    ...USERS,
    'p/Profile.java': `${J} @Entity @Table(name = "profiles") public class Profile { @Id Long id; @MapsId @OneToOne @JoinColumn(name = "user_id") User user; @Column(name = "bio") String bio; }`,
  }, { namingStrategy: 'spring-snake-case' });
  if (!r) { t.skip(SKIP); return; }
  assert.deepEqual(r.columns('profiles'), ['bio', 'user_id']);
  has(r, 'findAll READS column:profiles.user_id EXACT');
  assert.ok(r.joins.includes('profiles.user_id=users.id EXACT'), r.joins.join('\n'));
});

test('an empty @MapsId with no join column: the key is the one column the association names, and a disagreement is said', (t) => {
  const r = jpaRun(t, {
    ...USERS,
    'p/Profile.java': `${J} @Entity @Table(name = "profiles") public class Profile { @Id Long id; @MapsId @OneToOne User user; @Column(name = "bio") String bio; }`,
  }, { namingStrategy: 'spring-snake-case' });
  if (!r) { t.skip(SKIP); return; }
  assert.equal(r.columns('profiles').length, 2, r.columns('profiles').join(', '));
  assert.ok(!r.sql.some((s) => /profiles\.(id|user_id) EXACT$/.test(s)), r.sql.join('\n'));
  assert.ok(notes(r).some((n) => /Profile\.user/.test(n) && /@MapsId/.test(n)), notes(r).join('\n'));
});

// ---------------------------------------------------------------------------
// defect 3: an embeddable inside an embeddable, and an embedded value
// ---------------------------------------------------------------------------

const ADDR = {
  'p/Addr.java': `${J} @Embeddable public class Addr { @Column(name = "city") String city; Geo geo; }`,
  'p/Geo.java': `${J} @Embeddable public class Geo { Double lat; Double lng; }`,
  'p/ShopRepository.java': `${J} public interface ShopRepository extends JpaRepository<Shop, Long> { List<Shop> findAll(); }`,
};

test('an embedded value is the columns of its embeddable, nested ones included, with or without @Embedded', (t) => {
  for (const mark of ['@Embedded', '']) {
    const r = jpaRun(t, {
      ...ADDR,
      'p/Shop.java': `${J} @Entity @Table(name = "shops") public class Shop { @Id @Column(name = "id") Long id; ${mark} Addr addr; @ElementCollection List<Addr> branches; }`,
    }, { namingStrategy: 'spring-snake-case' });
    if (!r) { t.skip(SKIP); return; }
    assert.deepEqual(r.columns('shops'), ['city', 'id', 'lat', 'lng'], `${mark || 'no @Embedded'}: ${r.columns('shops').join(', ')}`);
    has(r, 'findAll READS column:shops.lat EXACT');
    assert.ok(!notes(r).some((n) => /embedded-not-read/.test(n)), notes(r).join('\n'));
  }
});

test('@AttributeOverride on the embedding attribute renames by attribute path, a nested one by its dotted path', (t) => {
  const r = jpaRun(t, {
    ...ADDR,
    'p/Shop.java': `${J} @Entity @Table(name = "shops") public class Shop { @Id @Column(name = "id") Long id;
      @Embedded @AttributeOverrides({ @AttributeOverride(name = "city", column = @Column(name = "homeCity")), @AttributeOverride(name = "geo.lat", column = @Column(name = "home_lat")) }) Addr home; }`,
  }, { namingStrategy: 'spring-snake-case' });
  if (!r) { t.skip(SKIP); return; }
  assert.deepEqual(r.columns('shops'), ['home_city', 'home_lat', 'id', 'lng']);
  has(r, 'findAll READS column:shops.home_city EXACT');
  assert.ok(!notes(r).some((n) => /jpa-mapping-unread/.test(n)), notes(r).join('\n'));
});

test('a nested embeddable in an @EmbeddedId, with a dotted @AttributeOverride, is the nested type\'s columns', (t) => {
  const r = jpaRun(t, {
    'p/InnerKey.java': `${J} @Embeddable public class InnerKey { Long a; Long b; }`,
    'p/OuterKey.java': `${J} @Embeddable public class OuterKey { InnerKey inner; Long c; }`,
    'p/Thing.java': `${J} @Entity @Table(name = "things") public class Thing { @EmbeddedId @AttributeOverride(name = "inner.a", column = @Column(name = "first_a")) OuterKey key; }`,
    'p/ThingRepository.java': `${J} public interface ThingRepository extends JpaRepository<Thing, OuterKey> { List<Thing> findAll(); }`,
  }, { namingStrategy: 'spring-snake-case' });
  if (!r) { t.skip(SKIP); return; }
  assert.deepEqual(r.columns('things'), ['b', 'c', 'first_a']);
  has(r, 'findAll READS column:things.first_a EXACT');
});

test('an association inside an embedded value is said, and the columns the value names keep their grade', (t) => {
  const r = jpaRun(t, {
    'p/Country.java': `${J} @Entity @Table(name = "countries") public class Country { @Id @Column(name = "id") Long id; }`,
    'p/Place.java': `${J} @Embeddable public class Place { @Column(name = "city") String city; @ManyToOne @JoinColumn(name = "country_id") Country country; @Transient String note; }`,
    'p/Shop.java': `${J} @Entity @Table(name = "shops") public class Shop { @Id @Column(name = "id") Long id; @Embedded Place place; }`,
    'p/ShopRepository.java': `${J} public interface ShopRepository extends JpaRepository<Shop, Long> { List<Shop> findAll(); }`,
  }, { namingStrategy: 'spring-snake-case' });
  if (!r) { t.skip(SKIP); return; }
  assert.deepEqual(r.columns('shops'), ['city', 'id']);
  has(r, 'findAll READS column:shops.city EXACT');
  assert.ok(notes(r).some((n) => /embeddable-not-read/.test(n) && /Place\.country/.test(n)), notes(r).join('\n'));
});

test('a nested type the tree does not hold is no invented column: the gap is said and the key is a guess', (t) => {
  const r = jpaRun(t, {
    'p/Key2.java': `${J} @Embeddable public class Key2 { lib.Money amount; @Column(name = "code") String code; }`,
    'p/Thing.java': `${J} @Entity @Table(name = "things") public class Thing { @EmbeddedId Key2 key; }`,
    'p/ThingRepository.java': `${J} public interface ThingRepository extends JpaRepository<Thing, Key2> { List<Thing> findAll(); }`,
  }, { namingStrategy: 'spring-snake-case' });
  if (!r) { t.skip(SKIP); return; }
  assert.deepEqual(r.columns('things'), ['code']);
  has(r, 'findAll READS column:things.code HEURISTIC');
  assert.ok(notes(r).some((n) => /Key2\.amount/.test(n) && /Money/.test(n)), notes(r).join('\n'));
});

// ---------------------------------------------------------------------------
// defect 4: an annotation the tree declares that cannot change a mapping
// ---------------------------------------------------------------------------

const META = 'import java.lang.annotation.Documented; import java.lang.annotation.ElementType; import java.lang.annotation.Retention; import java.lang.annotation.RetentionPolicy; import java.lang.annotation.Target;';
const CLONEABLE = `package p; ${META} @Target({ ElementType.FIELD }) @Retention(RetentionPolicy.RUNTIME) @Documented public @interface Cloneable {}`;
const PERF = (imports = '') => `${J} ${imports} @Entity @Table(name = "perf_test") public class PerfTest { @Id @Column(name = "id") Long id; @Cloneable @Column(name = "test_name") String testName; }`;
const PERF_REPO = { 'p/PerfTestRepository.java': `${J} public interface PerfTestRepository extends JpaRepository<PerfTest, Long> { List<PerfTest> findAll(); }` };

test('ngrinder\'s @Cloneable, declared in the tree with java.lang.annotation only, leaves its column as the mapping says', (t) => {
  const r = jpaRun(t, { ...PERF_REPO, 'p/Cloneable.java': CLONEABLE, 'p/PerfTest.java': PERF() }, { namingStrategy: 'spring-snake-case' });
  if (!r) { t.skip(SKIP); return; }
  has(r, 'findAll READS column:perf_test.test_name EXACT');
  assert.ok(!notes(r).some((n) => /jpa-annotation-unknown/.test(n)), notes(r).join('\n'));
  assert.deepEqual(r.stats.inertAnnotations, ['p.Cloneable']);
});

test('(a) a name the file means as another type than the tree\'s is still unknown', (t) => {
  const r = jpaRun(t, { ...PERF_REPO, 'p/Cloneable.java': CLONEABLE, 'p/PerfTest.java': PERF('import org.other.Cloneable;') }, { namingStrategy: 'spring-snake-case' });
  if (!r) { t.skip(SKIP); return; }
  has(r, 'findAll READS column:perf_test.test_name HEURISTIC');
  assert.ok(notes(r).some((n) => /jpa-annotation-unknown/.test(n) && /@Cloneable/.test(n)), notes(r).join('\n'));
});

test('(b) an annotation whose declaration carries a Hibernate meta-annotation is still unknown', (t) => {
  const decl = `package p; ${META} @Target({ ElementType.FIELD }) @Retention(RetentionPolicy.RUNTIME) @org.hibernate.annotations.ValueGenerationType(generatedBy = Gen.class) public @interface Cloneable {}`;
  const r = jpaRun(t, { ...PERF_REPO, 'p/Cloneable.java': decl, 'p/PerfTest.java': PERF() }, { namingStrategy: 'spring-snake-case' });
  if (!r) { t.skip(SKIP); return; }
  has(r, 'findAll READS column:perf_test.test_name HEURISTIC');
  assert.deepEqual(r.stats.inertAnnotations, []);
});

test('(c) a tree that hands Hibernate an Integrator keeps every such annotation unknown', (t) => {
  const r = jpaRun(t, {
    ...PERF_REPO, 'p/Cloneable.java': CLONEABLE, 'p/PerfTest.java': PERF(),
    'p/Wiring.java': 'package p; import org.hibernate.integrator.spi.Integrator; public class Wiring implements Integrator {}',
  }, { namingStrategy: 'spring-snake-case' });
  if (!r) { t.skip(SKIP); return; }
  has(r, 'findAll READS column:perf_test.test_name HEURISTIC');
  assert.deepEqual(r.stats.inertAnnotations, []);
  assert.ok(notes(r).some((n) => /inert-annotations-blocked/.test(n) && /p\.Wiring/.test(n) && /p\.Cloneable/.test(n)), notes(r).join('\n'));
});
