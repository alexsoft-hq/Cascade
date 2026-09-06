// petclinic.test.mjs — the JPA lane against a REAL project (SPEC §14, §15 M10).
//
// spring-petclinic is the reference Spring Data JPA application: @Entity with
// @Table/@Column, three levels of @MappedSuperclass, @ManyToOne/@OneToMany/
// @ManyToMany with an explicit @JoinTable, derived queries, a @Query, and a
// MySQL DDL that gives the physical truth to check the mapping against.
//
// EVERY expectation below was read out of the fixture's SOURCE and its
// schema.sql — never out of this engine's output (§14: a golden derived from
// the engine tests only that the engine agrees with itself). The comment above
// each assertion names the file and the declaration it comes from.
//
// The checkout is CLONED to a temp directory and analysed there: the fixture is
// read-only, and `cascade init` writes a `.cascade/` into the tree it is given.
// The home registry and the shard cache are redirected too, so running this
// test changes nothing outside its temp directory.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadPack } from '../src/core/pack.mjs';
import { callTool } from '../src/mcp/catalog.mjs';
import { computeTrust } from '../src/core/trust.mjs';
import { findJdk } from '../scripts/ci-java-smoke.mjs';

const ENGINE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const CLI = path.join(ENGINE_ROOT, 'bin', 'cascade.mjs');
const VENV_PY = path.join(ENGINE_ROOT, '.venv', 'bin', 'python');

/**
 * The pinned commit. The goldens below describe the source AT THIS COMMIT; a
 * different one is a different project, so the test refuses it rather than
 * scoring the engine against a fixture that moved underneath it.
 */
const PINNED_COMMIT = '818c4136ea971c21674525f9053de0d9c7ad8cfe';

/** Where the orchestrator/CI puts the clone. */
const FIXTURE = process.env.CASCADE_PETCLINIC
  ?? path.resolve(ENGINE_ROOT, '..', 'target-examples', 'spring-petclinic');

const DDL_REL = 'src/main/resources/db/mysql/schema.sql';
const SRC_REL = 'src/main/java';

function preflight() {
  if (!fs.existsSync(path.join(FIXTURE, DDL_REL))) {
    return `no spring-petclinic checkout at ${FIXTURE} — clone it at ${PINNED_COMMIT} `
      + '(git clone https://github.com/spring-projects/spring-petclinic) or set CASCADE_PETCLINIC';
  }
  if (!findJdk()) {
    return 'no JDK found: JAVA_HOME is unset and no javac on PATH — the Java lane cannot run (see docs/setup/java-lane.md)';
  }
  if (!fs.existsSync(VENV_PY)) {
    return `no venv python at ${VENV_PY} — the DDL catalog cannot be parsed (see docs/setup/sql-lane.md)`;
  }
  return null;
}

/** Clone the fixture at the pinned commit into `dir`. Never touches the source. */
function cloneFixture(dir) {
  execFileSync('git', ['clone', '--quiet', '--no-hardlinks', FIXTURE, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['-C', dir, 'checkout', '--quiet', PINNED_COMMIT], { stdio: ['ignore', 'pipe', 'pipe'] });
  const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD']).toString('utf8').trim();
  assert.equal(head, PINNED_COMMIT, 'the clone must sit on the pinned commit');
}

function askOf(packDir) {
  const pack = JSON.parse(fs.readFileSync(path.join(packDir, 'pack.json'), 'utf8'));
  const graph = loadPack(pack, { verifyDigest: true });
  const ctx = {
    graph,
    basis: { project: pack.meta.project, buildDigest: pack.digest, builtAt: pack.meta.builtAt, freshness: { verdict: 'unknown' } },
    trust: computeTrust({}),
    limits: [],
    pack: {
      project: pack.meta.project, digest: pack.digest, builtAt: pack.meta.builtAt,
      lanes: pack.meta.lanes, base: pack.meta.base, axes: pack.meta.axes, laneStats: pack.meta.laneStats,
    },
    profile: null,
  };
  return { pack, graph, ask: (name, args) => callTool(name, args, ctx) };
}

test('spring-petclinic: the JPA lane, end to end', { timeout: 900000 }, (t) => {
  const why = preflight();
  if (why) { t.skip(why); return; }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-petclinic-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const repo = path.join(work, 'repo');
  cloneFixture(repo);

  const cli = (args) => spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8', maxBuffer: 1 << 28,
    env: {
      ...process.env,
      XDG_CACHE_HOME: path.join(work, 'cache'),
      CASCADE_HOME: path.join(work, 'home'),
    },
  });

  const init = cli(['init', '--root', repo, '--project', 'petclinic']);
  assert.equal(init.status, 0, init.stderr);
  // `cascade init` must declare the jpa pack from the @Entity files it counted.
  const profile = JSON.parse(fs.readFileSync(path.join(repo, '.cascade', 'profile.json'), 'utf8'));
  assert.ok(profile.frameworkPacks.includes('jpa'), `frameworkPacks: ${profile.frameworkPacks}`);
  assert.equal(profile.jpa.namingStrategy, null, 'init records no strategy — it did not measure one');
  // petclinic carries THREE schema.sql files (h2/mysql/postgres), so init leaves
  // catalog.source "none" rather than picking one; the run below names the MySQL
  // one explicitly, which is why --ddl is passed.
  assert.equal(profile.catalog.source, 'none');

  const analyze = cli([
    'analyze', '--root', repo, '--project', 'petclinic',
    '--ddl', path.join(repo, DDL_REL),
    '--java-src', path.join(repo, SRC_REL),
    '--no-mappers',
  ]);
  assert.equal(analyze.status, 0, analyze.stderr);
  const err = analyze.stderr;
  assert.match(err, /JPA lane: 6 entities \(\+3 mapped superclass\(es\)\), 3 repositories/, err);
  // The MySQL DDL declares 7 tables and 24 columns; every JPA column must land
  // on one of them, so the pack must gain NO stub column.
  assert.match(err, /"tables":7/, 'the catalog worker read the 7 tables of db/mysql/schema.sql');

  const { pack, graph, ask } = askOf(path.join(repo, '.cascade', 'pack'));
  assert.equal(pack.meta.base.commit, PINNED_COMMIT, 'the pack pins the commit it read');

  // -----------------------------------------------------------------------
  // 1. entity -> table. Read from the @Table annotations, one file each:
  //    owner/Owner.java:@Table(name="owners")    owner/Pet.java:"pets"
  //    owner/Visit.java:"visits"                 owner/PetType.java:"types"
  //    vet/Vet.java:"vets"                       vet/Specialty.java:"specialties"
  //    model/{BaseEntity,NamedEntity,Person}.java are @MappedSuperclass: no table.
  // -----------------------------------------------------------------------
  const mapped = [...graph.nodes.values()]
    .filter((n) => n.kind === 'table' && n.jpaEntity)
    .map((n) => [n.jpaEntity.replace('org.springframework.samples.petclinic.', ''), n.id.slice('table:'.length), n.jpaMappingGrade])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  assert.deepEqual(mapped, [
    ['owner.Owner', 'owners', 'EXACT'],
    ['owner.Pet', 'pets', 'EXACT'],
    ['owner.PetType', 'types', 'EXACT'],
    ['owner.Visit', 'visits', 'EXACT'],
    ['vet.Specialty', 'specialties', 'EXACT'],
    ['vet.Vet', 'vets', 'EXACT'],
  ], 'every entity declares its table with @Table, so every mapping is EXACT');
  for (const [, table] of mapped) {
    assert.equal(graph.nodes.get(`table:${table}`).stub, undefined, `${table} is a catalog table, not a stub`);
    assert.equal(graph.nodes.get(`table:${table}`).jpaCatalogMatch, true);
  }
  // The @ManyToMany join table: vet/Vet.java declares
  //   @JoinTable(name="vet_specialties", joinColumns=@JoinColumn(name="vet_id"),
  //              inverseJoinColumns=@JoinColumn(name="specialty_id"))
  // and db/mysql/schema.sql declares the same table with the same two columns.
  assert.ok(graph.nodes.has('table:vet_specialties'));
  assert.ok(graph.nodes.has('column:vet_specialties.vet_id'));
  assert.ok(graph.nodes.has('column:vet_specialties.specialty_id'));
  const vsJoins = graph.edges.filter((e) => e.type === 'JOINS' && [e.from, e.to].includes('table:vet_specialties'));
  assert.deepEqual(vsJoins.map((e) => [e.from, e.to, e.grade].join(' ')).sort(), [
    'table:specialties table:vet_specialties EXACT',
    'table:vet_specialties table:vets EXACT',
  ]);

  // The mapping must not invent a column: db/mysql/schema.sql is the truth, and
  // every column the JPA bridge derived has to be one of its 24.
  const stubbed = [...graph.nodes.values()].filter((n) => n.kind === 'column' && n.declaredBy === 'jpa');
  assert.deepEqual(stubbed.map((n) => n.id), [], 'every JPA column exists in db/mysql/schema.sql');

  // -----------------------------------------------------------------------
  // 2. column_impact on owners.last_name.
  //    owner/OwnerRepository.java:45 declares
  //       Page<Owner> findByLastNameStartingWith(String lastName, Pageable pageable);
  //    `lastName` is Person.lastName (model/Person.java, @Column(length=30) with
  //    NO name), so the column name is DERIVED -> HEURISTIC while the profile
  //    declares no jpa.namingStrategy.
  //    OwnerController/VisitController/PetController call owners.save(..) and
  //    owners.saveAndFlush(..), and a JPA save writes the whole row.
  // -----------------------------------------------------------------------
  const ci = ask('column_impact', { column: 'owners.last_name' });
  const R = 'org.springframework.samples.petclinic.owner.OwnerRepository.';
  assert.deepEqual(
    ci.answer.statements.map((s) => [s.id.replace(R, ''), s.access, s.grade]).sort(),
    [
      ['findByLastNameStartingWith', 'read', 'HEURISTIC'],
      ['save', 'write', 'HEURISTIC'],
      ['saveAndFlush', 'write', 'HEURISTIC'],
    ],
  );

  // -----------------------------------------------------------------------
  // 3. endpoint_impact on owners.last_name.
  //    owner/OwnerController.java:94 is @GetMapping("/owners") on
  //    processFindForm, which calls findPaginatedForOwnersLastName, which calls
  //    owners.findByLastNameStartingWith. The route is exactly "/owners" — the
  //    class carries no @RequestMapping.
  //    The whole path is HEURISTIC because its last link is the derived column
  //    name, so `conservative` (EXACT+SOUND_SET) must return NOTHING and say so.
  // -----------------------------------------------------------------------
  const strict = ask('endpoint_impact', { column: 'owners.last_name', mode: 'conservative' });
  assert.deepEqual(strict.answer.endpoints, [], 'the derived column name is below the conservative floor');
  assert.ok(strict.trust.knownGaps.includes('jpa-axis-degraded'), strict.trust.knownGaps.join(','));

  const eiPaths = ask('endpoint_impact', { column: 'owners.last_name', mode: 'heuristic' })
    .answer.endpoints.map((e) => e.id).sort();
  assert.ok(eiPaths.includes('GET /owners'), `GET /owners must be reachable, got ${eiPaths}`);
  assert.deepEqual(eiPaths, [
    'GET /owners',                                    // OwnerController#processFindForm -> findByLastNameStartingWith
    'POST /owners/new',                               // OwnerController#processCreationForm -> owners.save
    'POST /owners/{ownerId}/edit',                    // OwnerController#processUpdateOwnerForm -> owners.save
    'POST /owners/{ownerId}/pets/new',                // PetController#processCreationForm -> owners.saveAndFlush
    'POST /owners/{ownerId}/pets/{petId}/edit',       // PetController#processUpdateForm -> updatePetDetails -> saveAndFlush
    'POST /owners/{ownerId}/pets/{petId}/visits/new', // VisitController#processNewVisitForm -> owners.save
  ]);

  // -----------------------------------------------------------------------
  // 4. visits.visit_date is written by the visit-saving path.
  //    owner/Visit.java declares @Column(name="visit_date") — EXPLICIT, so the
  //    column mapping is EXACT whatever the naming strategy.
  //    owner/VisitController.java:97 is @PostMapping("/owners/{ownerId}/pets/
  //    {petId}/visits/new") on processNewVisitForm, which calls
  //    this.owners.save(owner). Owner.pets is @OneToMany(cascade=ALL) and
  //    Pet.visits is @OneToMany(cascade=ALL), so that save reaches the visit row
  //    — a SOUND candidate set (the child may be clean), never EXACT.
  // -----------------------------------------------------------------------
  const vd = ask('column_impact', { column: 'visits.visit_date' });
  assert.deepEqual(vd.answer.statements.map((s) => [s.id.replace(R, ''), s.access, s.grade]).sort(), [
    ['save', 'write', 'SOUND_SET'],
    ['saveAndFlush', 'write', 'SOUND_SET'],
  ]);
  const vdEndpoints = ask('endpoint_impact', { column: 'visits.visit_date', mode: 'conservative' })
    .answer.endpoints;
  assert.ok(
    vdEndpoints.some((e) => e.id === 'POST /owners/{ownerId}/pets/{petId}/visits/new' && e.grade === 'SOUND_SET'),
    `the visit-saving endpoint must write visits.visit_date, got ${JSON.stringify(vdEndpoints)}`,
  );

  // -----------------------------------------------------------------------
  // 5. the statement census, hand-counted from the three repository files.
  //    OwnerRepository:   findByLastNameStartingWith, findById            (derived)
  //    VetRepository:     findAll(), findAll(Pageable)  -> ONE statement  (derived)
  //    PetTypeRepository: findPetTypes @Query(JPQL)                       (jpql)
  //    called-but-undeclared built-ins: OwnerRepository.save (OwnerController,
  //    VisitController) and OwnerRepository.saveAndFlush (PetController).
  //    Nothing in the tree is @Query(nativeQuery = true).
  // -----------------------------------------------------------------------
  const byType = new Map();
  for (const n of graph.nodes.values()) {
    if (n.kind === 'statement') byType.set(n.statementType, (byType.get(n.statementType) ?? 0) + 1);
  }
  assert.deepEqual([...byType.entries()].sort(), [['builtin', 2], ['derived', 3], ['jpql', 1]]);

  // -----------------------------------------------------------------------
  // 6. the unresolved count, hand-checked. Every property path in the tree
  //    resolves against the entity model:
  //      findByLastNameStartingWith -> Person.lastName          (inherited)
  //      findById                   -> BaseEntity.id            (inherited)
  //      findAll                    -> no predicate: the whole row
  //      findPetTypes @Query "SELECT ptype FROM PetType ptype ORDER BY ptype.name"
  //                                 -> PetType via NamedEntity.name
  //    so the expected number of statements with an unresolved part is ZERO.
  // -----------------------------------------------------------------------
  const unresolved = [...graph.nodes.values()].filter((n) => n.kind === 'statement' && n.hasUnresolved === true);
  assert.deepEqual(unresolved.map((n) => ({ id: n.id, why: n.unresolved })), [],
    'no derived name or JPQL fragment in petclinic should fail to resolve');
  const ov = ask('overview', {});
  assert.deepEqual(ov.answer.jpa, { entities: 6, repositories: 3, statements: 6, unresolvedStatements: 0 });

  // -----------------------------------------------------------------------
  // 7. the pack DECLARES what it derived rather than leaving it to be assumed.
  // -----------------------------------------------------------------------
  assert.equal(pack.meta.axes.jpa.status, 'degraded');
  assert.match(pack.meta.axes.jpa.reason, /jpa\.namingStrategy/);
  assert.equal(pack.meta.laneStats.parseErrors, 0, 'the fixture parses cleanly');
  assert.ok(pack.meta.laneStats.parsedFiles > 20, `parsedFiles=${pack.meta.laneStats.parsedFiles}`);
});

test('spring-petclinic: a DECLARED naming strategy turns the derived mappings EXACT', { timeout: 900000 }, (t) => {
  const why = preflight();
  if (why) { t.skip(why); return; }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-petclinic-declared-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const repo = path.join(work, 'repo');
  cloneFixture(repo);

  const cli = (args) => spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8', maxBuffer: 1 << 28,
    env: { ...process.env, XDG_CACHE_HOME: path.join(work, 'cache'), CASCADE_HOME: path.join(work, 'home') },
  });
  assert.equal(cli(['init', '--root', repo, '--project', 'petclinic']).status, 0);

  // Spring Boot's default IS CamelCase -> snake_case, and petclinic's
  // application.properties sets no naming strategy — so declaring it here is a
  // statement of fact about the project, which is exactly what the key is for.
  const profilePath = path.join(repo, '.cascade', 'profile.json');
  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  profile.jpa.namingStrategy = 'spring-snake-case';
  fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2) + '\n');

  const analyze = cli([
    'analyze', '--root', repo, '--project', 'petclinic',
    '--ddl', path.join(repo, DDL_REL), '--java-src', path.join(repo, SRC_REL), '--no-mappers',
  ]);
  assert.equal(analyze.status, 0, analyze.stderr);
  assert.match(analyze.stderr, /naming strategy spring-snake-case \(declared\)/);

  const { pack, ask } = askOf(path.join(repo, '.cascade', 'pack'));
  assert.equal(pack.meta.axes.jpa.status, 'shipped');

  // owners.last_name is now EXACT, so the SAME question answers under the
  // conservative floor — and the endpoint grade drops only to SOUND_SET, which
  // is the controller -> repository CALL, not the mapping.
  const ci = ask('column_impact', { column: 'owners.last_name' });
  assert.equal(ci.answer.statements.every((s) => s.grade === 'EXACT'), true, JSON.stringify(ci.answer.statements));
  const ei = ask('endpoint_impact', { column: 'owners.last_name', mode: 'conservative' });
  assert.ok(ei.answer.endpoints.some((e) => e.id === 'GET /owners' && e.grade === 'SOUND_SET'),
    JSON.stringify(ei.answer.endpoints));
});
