// petclinic_graph.mjs — the spring-petclinic graph, built here rather than
// analysed, for the tests that read the REAL agent capture beside it
// (test/fixtures/otel/petclinic-agent.log).
//
// WHY IT IS BUILT AND NOT ANALYSED. The capture is real: it came out of
// spring-petclinic running under the OpenTelemetry Java agent. Joining it needs
// a graph keyed the way the Java and JPA lanes key one, and building that here
// costs a JDK, a python, a checkout at a pinned commit and about a minute per
// run. The tests that need all of that already exist (petclinic.test.mjs).
// These ones are about the RUNTIME lane, so the graph is a fixture: the shape,
// read out of the analysed pack, written down.
//
// WHAT IS IN IT, and what is deliberately not:
//
//   - every route the pack serves, with the handler it dispatches to. Those are
//     the 17 `@GetMapping`/`@PostMapping` methods of the four controllers;
//   - every repository method the JPA lane turns into a statement, with the
//     `IMPLEMENTS_STMT` edge into it;
//   - every `MAY_CALL` edge OUT OF a controller or the formatter, which is the
//     part of the call graph the dispatch join walks.
//
// Left out: the `MAY_CALL` edges inside the model classes (`Owner#addPet` ->
// `Owner#getPets` and its like). Nothing in them serves a route and nothing in
// them reaches a statement, so they change no answer either test asks, and
// carrying them would only make this file longer.
//
// Grades are the ones the lanes really assign: `EXACT` for a route mapping and
// for a derived-query statement, `SOUND_SET` for a call through a field whose
// declared type may have a subtype at run time. The runtime lane must leave
// every one of them exactly as it found it, so a fixture with the wrong grades
// would test nothing.

import { Graph } from '../../src/core/graph.mjs';
import { projectPack } from '../../src/core/pack.mjs';

const P = 'org.springframework.samples.petclinic.';

/** route -> the method that handles it. `HANDLES`, graded EXACT. */
const ROUTES = [
  ['GET', '/', 'system.WelcomeController#welcome'],
  ['GET', '/oups', 'system.CrashController#triggerException'],
  ['GET', '/owners', 'owner.OwnerController#processFindForm'],
  ['GET', '/owners/find', 'owner.OwnerController#initFindForm'],
  ['GET', '/owners/new', 'owner.OwnerController#initCreationForm'],
  ['GET', '/owners/{ownerId}', 'owner.OwnerController#showOwner'],
  ['GET', '/owners/{ownerId}/edit', 'owner.OwnerController#initUpdateOwnerForm'],
  ['GET', '/owners/{ownerId}/pets/new', 'owner.PetController#initCreationForm'],
  ['GET', '/owners/{ownerId}/pets/{petId}/edit', 'owner.PetController#initUpdateForm'],
  ['GET', '/owners/{ownerId}/pets/{petId}/visits/new', 'owner.VisitController#initNewVisitForm'],
  ['GET', '/vets', 'vet.VetController#showResourcesVetList'],
  ['GET', '/vets.html', 'vet.VetController#showVetList'],
  ['POST', '/owners/new', 'owner.OwnerController#processCreationForm'],
  ['POST', '/owners/{ownerId}/edit', 'owner.OwnerController#processUpdateOwnerForm'],
  ['POST', '/owners/{ownerId}/pets/new', 'owner.PetController#processCreationForm'],
  ['POST', '/owners/{ownerId}/pets/{petId}/edit', 'owner.PetController#processUpdateForm'],
  ['POST', '/owners/{ownerId}/pets/{petId}/visits/new', 'owner.VisitController#processNewVisitForm'],
];

/** The repository methods the JPA lane turns into a statement. */
const STATEMENTS = [
  'owner.OwnerRepository#findById',
  'owner.OwnerRepository#findByLastNameStartingWith',
  'owner.OwnerRepository#save',
  'owner.OwnerRepository#saveAndFlush',
  'owner.PetTypeRepository#findPetTypes',
  'vet.VetRepository#findAll',
];

/** Every `MAY_CALL` out of a controller or the formatter. */
const CALLS = [
  ['owner.OwnerController#findOwner', 'owner.OwnerRepository#findById'],
  ['owner.OwnerController#findPaginatedForOwnersLastName', 'owner.OwnerRepository#findByLastNameStartingWith'],
  ['owner.OwnerController#processCreationForm', 'owner.OwnerRepository#save'],
  ['owner.OwnerController#processFindForm', 'owner.OwnerController#addPaginationModel'],
  ['owner.OwnerController#processFindForm', 'owner.OwnerController#findPaginatedForOwnersLastName'],
  ['owner.OwnerController#processUpdateOwnerForm', 'owner.OwnerRepository#save'],
  ['owner.OwnerController#showOwner', 'owner.OwnerRepository#findById'],
  ['owner.PetController#findOwner', 'owner.OwnerRepository#findById'],
  ['owner.PetController#findPet', 'owner.OwnerRepository#findById'],
  ['owner.PetController#populatePetTypes', 'owner.PetTypeRepository#findPetTypes'],
  ['owner.PetController#processCreationForm', 'owner.OwnerRepository#saveAndFlush'],
  ['owner.PetController#processCreationForm', 'owner.PetController#isDuplicatePetNameViolation'],
  ['owner.PetController#processUpdateForm', 'owner.PetController#isDuplicatePetNameViolation'],
  ['owner.PetController#processUpdateForm', 'owner.PetController#updatePetDetails'],
  ['owner.PetController#updatePetDetails', 'owner.OwnerRepository#saveAndFlush'],
  ['owner.PetTypeFormatter#parse', 'owner.PetTypeRepository#findPetTypes'],
  ['owner.VisitController#loadPetWithVisit', 'owner.OwnerRepository#findById'],
  ['owner.VisitController#processNewVisitForm', 'owner.OwnerRepository#save'],
  ['vet.VetController#findPaginated', 'vet.VetRepository#findAll'],
  ['vet.VetController#showResourcesVetList', 'vet.VetRepository#findAll'],
  ['vet.VetController#showVetList', 'vet.VetController#addPaginationModel'],
  ['vet.VetController#showVetList', 'vet.VetController#findPaginated'],
];

/** `owner.X#m` -> the node id the Java lane keys it by. */
const sym = (short) => `symbol:${P}${short}`;
/** `owner.X#m` -> the statement node id the JPA lane keys it by. */
const stmt = (short) => `statement:${P}${short.replace('#', '.')}`;

/** The graph, fresh each call so a test can annotate it without affecting another. */
export function petclinicGraph() {
  const g = new Graph();
  const symbol = (short) => {
    const id = sym(short);
    if (g.nodes.has(id)) return id;
    const member = `${P}${short}`;
    g.addNode({ id, kind: 'symbol', symbol: member, owner: member.slice(0, member.lastIndexOf('#')) });
    return id;
  };

  for (const [httpMethod, routePath, handler] of ROUTES) {
    const id = `endpoint:${httpMethod} ${routePath}`;
    g.addNode({ id, kind: 'endpoint', httpMethod, path: routePath, handler: `${P}${handler}` });
    g.addEdge({ from: id, to: symbol(handler), type: 'HANDLES', grade: 'EXACT' });
  }
  for (const short of STATEMENTS) {
    const id = stmt(short);
    g.addNode({ id, kind: 'statement', statementType: 'derived', source: 'jpa' });
    g.addEdge({ from: symbol(short), to: id, type: 'IMPLEMENTS_STMT', grade: 'EXACT' });
  }
  for (const [from, to] of CALLS) {
    g.addEdge({
      from: symbol(from),
      to: symbol(to),
      type: 'MAY_CALL',
      grade: 'SOUND_SET',
      evidence: { rule: 'this-field', basis: 'a call through a field, resolved to the declared type. The runtime object may be a subtype', receiver: to.split('#')[0].split('.').pop() },
    });
  }
  return g;
}

/** The same graph as a pack document, ready to be written as `pack.json`. */
export function petclinicPack(meta = {}) {
  return projectPack(petclinicGraph(), { project: 'petclinic', ...meta });
}

/** Node ids the tests name, spelled once. */
export const PETCLINIC_IDS = Object.freeze({
  showOwner: sym('owner.OwnerController#showOwner'),
  findById: sym('owner.OwnerRepository#findById'),
  processFindForm: sym('owner.OwnerController#processFindForm'),
  findByLastNameStartingWith: sym('owner.OwnerRepository#findByLastNameStartingWith'),
  showVetList: sym('vet.VetController#showVetList'),
  findAll: sym('vet.VetRepository#findAll'),
  processCreationForm: sym('owner.OwnerController#processCreationForm'),
  save: sym('owner.OwnerRepository#save'),
  showResourcesVetList: sym('vet.VetController#showResourcesVetList'),
  findByIdStatement: stmt('owner.OwnerRepository#findById'),
  ownersEndpoint: 'endpoint:GET /owners/{ownerId}',
});
