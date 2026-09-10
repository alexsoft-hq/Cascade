// java_worker_jpa.test.mjs — what adapters/java/JavaFacts.java records about the
// FETCH PLAN of a JPA mapping (javafacts/10), read back off real
// compiled-and-run output.
//
// Three things went into the worker this round, and all three are evidence and
// nothing more:
//
//   * `fetch` on an association — the constant the annotation writes, and null
//     when it writes none. What null MEANS is the JPA specification's default,
//     which depends on the relation kind, and that is decided in
//     src/adapters/jpa_bridge.mjs;
//   * `targetEntity` — the other side written as a class literal, for a mapping
//     that does not leave it to the field's own type;
//   * `entityGraph` on a repository method, and `namedEntityGraphs` on the
//     entity that declares the plan the method names. The two halves are in two
//     files, so the worker records both as written and joins neither.
//
// And one for the web side: `modelAttributeMethods`, the methods a class
// declares that carry `@ModelAttribute`. A PARAMETER may carry the same
// annotation, which is a binding and not a method Spring runs, so the two must
// not be confused.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findJdk } from '../scripts/ci-java-smoke.mjs';
import { JAVA_WORKER_VERSION } from '../src/core/worker_versions.mjs';

const ENGINE_ROOT = fileURLToPath(new URL('../', import.meta.url));

const SOURCES = {
  'Owner.java': `package com.example;
import jakarta.persistence.*;
import java.util.List;

@Entity
@Table(name = "owners")
@NamedEntityGraph(name = "Owner.withPets", attributeNodes = { @NamedAttributeNode("pets"), @NamedAttributeNode("address") })
public class Owner {
    @Id
    private Integer id;
    private String lastName;

    // WRITTEN DOWN: the constant the mapping names.
    @OneToMany(cascade = CascadeType.ALL, fetch = FetchType.EAGER)
    @JoinColumn(name = "owner_id")
    private List<Pet> pets;

    // NOT WRITTEN: the record says null, and the default is the bridge's call.
    @ManyToOne
    @JoinColumn(name = "address_id")
    private Address address;

    // A raw collection that names the other side in the annotation instead.
    @OneToMany(targetEntity = Note.class, fetch = FetchType.LAZY, mappedBy = "owner")
    private List notes;
}
`,
  'Pet.java': `package com.example;
import jakarta.persistence.*;

@Entity
public class Pet {
    @Id
    private Integer id;
}
`,
  'Address.java': `package com.example;
import jakarta.persistence.*;

@Entity
public class Address {
    @Id
    private Integer id;
}
`,
  'Note.java': `package com.example;
import jakarta.persistence.*;

@Entity
@NamedEntityGraphs({
    @NamedEntityGraph(name = "Note.one", attributeNodes = @NamedAttributeNode("owner")),
    @NamedEntityGraph(name = "Note.two", attributeNodes = { @NamedAttributeNode("owner") })
})
public class Note {
    @Id
    private Integer id;
    @ManyToOne
    private Owner owner;
}
`,
  'OwnerRepository.java': `package com.example;
import java.util.List;
import org.springframework.data.jpa.repository.EntityGraph;
import org.springframework.data.jpa.repository.JpaRepository;

public interface OwnerRepository extends JpaRepository<Owner, Integer> {

    @EntityGraph(attributePaths = { "pets", "address" })
    List<Owner> findByLastName(String lastName);

    @EntityGraph("Owner.withPets")
    List<Owner> findByIdGreaterThan(Integer id);

    List<Owner> findAll();
}
`,
  'OwnerController.java': `package com.example;
import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.ModelAttribute;
import org.springframework.web.bind.annotation.PostMapping;

@Controller
public class OwnerController {

    @ModelAttribute("owner")
    public Owner findOwner(Integer ownerId) {
        return null;
    }

    @ModelAttribute("clock")
    public String clock() {
        return "now";
    }

    @GetMapping("/owners/{ownerId}/edit")
    public String edit() {
        return "owners/form";
    }

    // A PARAMETER annotation, which is a binding and not a method Spring runs.
    @PostMapping("/owners/{ownerId}/edit")
    public String save(@ModelAttribute Owner owner) {
        return "redirect:/owners";
    }
}
`,
  'PlainService.java': `package com.example;

public class PlainService {
    public void work() {
    }
}
`,
};

function runWorker(jdk, dir) {
  const buildDir = path.join(dir, 'classes');
  fs.mkdirSync(buildDir, { recursive: true });
  execFileSync(jdk.javac, ['-d', buildDir, path.join(ENGINE_ROOT, 'adapters', 'java', 'JavaFacts.java')],
    { stdio: ['ignore', 'ignore', 'inherit'] });
  const src = path.join(dir, 'src');
  const out = execFileSync(jdk.java, ['-cp', buildDir, 'JavaFacts', '--root', src, src], { maxBuffer: 1 << 26 })
    .toString('utf8');
  return out.split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
}

function writeSources(dir) {
  const src = path.join(dir, 'src', 'com', 'example');
  fs.mkdirSync(src, { recursive: true });
  for (const [name, body] of Object.entries(SOURCES)) fs.writeFileSync(path.join(src, name), body);
}

/** The compiled-and-run records, once, for every test below. */
function records(t) {
  const jdk = findJdk();
  if (!jdk) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-javajpa-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeSources(dir);
  return runWorker(jdk, dir);
}

const SKIP = 'no JDK found: JAVA_HOME is unset and no javac on PATH — see docs/setup/java-lane.md';

test('javafacts/10: an association records the fetch the mapping WROTE, and null when it wrote none', (t) => {
  const recs = records(t);
  if (!recs) { t.skip(SKIP); return; }
  assert.equal(recs[0].kind, 'header');
  assert.equal(recs[0].version, JAVA_WORKER_VERSION, 'the mirrored version must be the one the worker stamps');

  const owner = recs.find((r) => r.kind === 'entity' && r.fqn === 'com.example.Owner');
  const by = new Map(owner.attributes.map((a) => [a.name, a]));

  assert.equal(by.get('pets').fetch, 'EAGER', 'FetchType.EAGER is recorded as the constant it names');
  assert.equal(by.get('pets').relation, 'oneToMany');
  // NOT WRITTEN is null, and stays null. A to-one is eager by the specification,
  // and that is a rule the BRIDGE applies — the worker would be inventing a line
  // of source that is not there.
  assert.equal(by.get('address').fetch, null);
  assert.equal(by.get('address').relation, 'manyToOne');
  assert.equal(by.get('notes').fetch, 'LAZY');
  // A field with no relation annotation at all has no fetch to record.
  assert.equal(by.get('lastName').fetch, null);
  assert.equal(by.get('lastName').relation, null);
});

test('javafacts/10: `targetEntity` records the class literal the mapping names', (t) => {
  const recs = records(t);
  if (!recs) { t.skip(SKIP); return; }
  const owner = recs.find((r) => r.kind === 'entity' && r.fqn === 'com.example.Owner');
  const by = new Map(owner.attributes.map((a) => [a.name, a]));
  // `List notes` is raw, so `typeArgSimple` says nothing and the annotation is
  // the only thing that names the other side.
  assert.equal(by.get('notes').targetEntity, 'Note');
  assert.equal(by.get('notes').typeArgSimple, null);
  // A mapping that leaves it to the field's type writes no targetEntity.
  assert.equal(by.get('pets').targetEntity, null);
  assert.equal(by.get('pets').typeArgSimple, 'Pet');
});

test('javafacts/10: an entity records the named fetch plans it declares, one or many', (t) => {
  const recs = records(t);
  if (!recs) { t.skip(SKIP); return; }
  const owner = recs.find((r) => r.kind === 'entity' && r.fqn === 'com.example.Owner');
  assert.deepEqual(owner.namedEntityGraphs, [
    { name: 'Owner.withPets', attributePaths: ['pets', 'address'] },
  ]);
  // @NamedEntityGraphs holds several, and a single @NamedAttributeNode outside
  // an array is the same declaration written shorter.
  const note = recs.find((r) => r.kind === 'entity' && r.fqn === 'com.example.Note');
  assert.deepEqual(note.namedEntityGraphs, [
    { name: 'Note.one', attributePaths: ['owner'] },
    { name: 'Note.two', attributePaths: ['owner'] },
  ]);
  // An entity that declares none carries an empty list, not a missing field.
  const pet = recs.find((r) => r.kind === 'entity' && r.fqn === 'com.example.Pet');
  assert.deepEqual(pet.namedEntityGraphs, []);
});

test('javafacts/10: a repository method records its @EntityGraph as written, resolving nothing', (t) => {
  const recs = records(t);
  if (!recs) { t.skip(SKIP); return; }
  const repo = recs.find((r) => r.kind === 'repository' && r.fqn === 'com.example.OwnerRepository');
  const by = new Map(repo.methods.map((m) => [m.name, m]));
  assert.deepEqual(by.get('findByLastName').entityGraph, { name: null, attributePaths: ['pets', 'address'] });
  // A NAMED plan is recorded by name. Which entity declares it, and what it
  // holds, is a question about another file, so the worker does not ask it.
  assert.deepEqual(by.get('findByIdGreaterThan').entityGraph, { name: 'Owner.withPets', attributePaths: [] });
  assert.equal(by.get('findAll').entityGraph, null, 'a method with no @EntityGraph carries null, not an empty plan');
});

test('javafacts/10: a class records the METHODS that carry @ModelAttribute, never a parameter', (t) => {
  const recs = records(t);
  if (!recs) { t.skip(SKIP); return; }
  const ctl = recs.find((r) => r.kind === 'type' && r.fqn === 'com.example.OwnerController');
  // `save(@ModelAttribute Owner owner)` is a BINDING: Spring fills the argument
  // in, it does not run the method to build a model attribute. It must not be
  // in this list, or every handler taking a form object would look like one.
  assert.deepEqual(ctl.modelAttributeMethods, ['findOwner', 'clock']);
  const plain = recs.find((r) => r.kind === 'type' && r.fqn === 'com.example.PlainService');
  assert.deepEqual(plain.modelAttributeMethods, [], 'a class with none carries an empty list, not a missing field');
});
