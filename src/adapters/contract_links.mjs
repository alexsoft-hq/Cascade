// contract_links.mjs — a document's route, joined to the Java method that handles it through an interface the source tree does not hold.
//
// A contract-first project's controllers implement interfaces a code generator
// writes from the OpenAPI document at build time. The Java lane cannot see those
// interfaces, so it sees no mapping, and the OpenAPI bridge puts the document's
// routes on the graph with nothing under them. Whether a generator really runs
// is in the build configuration, which is not read: what is read is a served
// class implementing an interface named as the generator would name it. The `java.contract-link` rules
// (src/core/rules/kinds/java_contract_link.mjs) say which method a generator's
// naming pairs with which operation; this is where their links become HANDLES
// edges, after the document's routes are on the graph.
//
// WHAT IT WRITES, and nothing else: one HANDLES edge per link, from the route
// the document declares to the method, graded as the rule grades it (HEURISTIC:
// the interface that would state the pairing is not in the source tree, so it is
// never read), with the rule, the operationId, the documents and the interface in
// its evidence. On a document the profile declares this code's interfaces are
// generated from (openapi.generatesCode) the interface is the one the build
// writes from it, so the link is the method its class declares, EXACT, when the
// interface's name holds under every scheme the generator groups operations by;
// where it does not, the grouping is a setting not read and the link stays the
// rule's guess. Either way the evidence names the declaration. The route node
// stays the document's, at the address the document gives it: where a
// deployment serves that base path (a context path, the class's own mapping) is
// not read, and a declaration does not settle it. A method the rules name
// without linking it (two routes for one operationId, an interface the operation
// would not be generated into) draws no edge and is counted and named in the
// census instead. A link whose route the code already maps to the same method
// draws nothing either: the code's own edge says more than the rule's, and it is
// counted apart (`alreadyHandled`), never as a link the rule gave.

import { builtinRegistry } from '../core/rules/registry.mjs';
import { deriveContractLinks, operationsOf } from '../core/rules/kinds/java_contract_link.mjs';
import { javaSymbolWriter } from './java_bridge.mjs';

/** What every contract link rests on, in one sentence, for `evidence.basis`. */
export const CONTRACT_LINK_BASIS = 'a document declares this operation, and this method\'s class is one the framework serves and implements an interface that is not in the source tree, named as the generator names the operation\'s group: the pairing is the generator\'s naming (the interface named for the operation\'s group, the method for its operationId), a convention and not a fact of the source. Neither that interface nor any generator configuration is read here';

/** What a link rests on when the profile declares its document generates this code, and the interface's name holds whatever the grouping. */
export const CONTRACT_LINK_DECLARED_BASIS = 'a document declares this operation, and this method\'s class is one the framework serves and implements an interface that is not in the source tree, named as the generator names the operation\'s group. The profile declares that the build generates this code\'s interfaces from the document (openapi.generatesCode), and every way the generator groups operations that gives an interface this name puts the operation into it, so the interface holds the operation\'s method and the link is the method this class declares';

/** The profile's word that the build generates this code's interfaces from a document (src/core/lanes.mjs openapiDeclarationsOf). */
const GENERATES_CODE = 'openapi.generatesCode';

/** Why a link on a declared document is still a guess: the interface's name depends on how the build groups operations. */
function namingDoubt(l) {
  const simple = l.interface.slice(l.interface.lastIndexOf('.') + 1);
  const by = l.namedBy.length > 0 ? `from its ${l.namedBy.join(' and ')}` : 'by no one scheme in every document that declares it';
  const other = l.nameFrom.filter((s) => !l.namedBy.includes(s));
  return `the operation gets the name ${simple} ${by}, and other operations get it from their ${other.join(' and ')}: `
    + 'which one the build names interfaces by is a setting of the generator this engine does not read';
}

/**
 * How sure one link is: the rule's grade, a naming convention; on a document the
 * profile declares generates this code, the method its class declares (EXACT)
 * when every scheme that gives some operation the interface's name puts this
 * operation into it (the kind's `nameFrom` and `namedBy`), else still the rule's.
 */
function howSure(l, generating) {
  const document = l.documents.find((d) => generating.has(d));
  if (!document) return { grade: l.grade, evidence: {} };
  const declared = { key: GENERATES_CODE, document };
  if (l.nameFrom.every((s) => l.namedBy.includes(s))) return { grade: 'EXACT', settled: true, evidence: { basis: CONTRACT_LINK_DECLARED_BASIS, declared } };
  return { grade: l.grade, evidence: { declared, naming: namingDoubt(l) } };
}

/** The evidence one link's edge carries. */
const linkEvidence = (l, how) => ({
  rule: l.rule, basis: CONTRACT_LINK_BASIS, operationId: l.operationId, documents: l.documents,
  interface: l.interface, generator: l.generator, match: 'operationId', ...how.evidence,
});

/** Draw each link that is not already the code's own edge: the links placed, graded, and the ones the code already had. */
function placeLinks(g, links, writer, generating) {
  const placed = [];
  const handled = [];
  for (const l of links) {
    if (!g.nodes.has(l.endpoint)) continue;
    const to = writer(l.handler);
    if (g.outEdges(l.endpoint).some((e) => e.type === 'HANDLES' && e.to === to)) { handled.push(l); continue; }
    const how = howSure(l, generating);
    g.addEdge({ from: l.endpoint, to, type: 'HANDLES', grade: how.grade, evidence: linkEvidence(l, how) });
    placed.push({ ...l, grade: how.grade, declared: how.evidence.declared ?? null, settled: how.settled === true });
  }
  return { placed, handled };
}

/** Per rule: how many links it drew, how many methods it named without one, and how many the code already mapped. */
function byRuleOf(links, unlinked, handled) {
  const out = {};
  const row = (id) => { out[id] ??= { links: 0, unlinked: 0, alreadyHandled: 0 }; return out[id]; };
  for (const l of links) row(l.rule).links += 1;
  for (const u of unlinked) row(u.rule).unlinked += 1;
  for (const l of handled) row(l.rule).alreadyHandled += 1;
  return Object.fromEntries(Object.keys(out).sort().map((k) => [k, out[k]]));
}

/**
 * Draw the HANDLES edges the contract rules give. Mutates `g`.
 *
 * Null when no rule gave a link and named nothing, so a project with no
 * contract written this way gets a pack with nothing added to it. `links`,
 * `endpoints` and `byRule[].links` count only the edges drawn: a route the code
 * already maps to the same method is `alreadyHandled`, so no census calls it a
 * guess.
 *
 * @param {import('../core/graph.mjs').Graph} g  a graph the OpenAPI bridge has put the document's routes on
 * @param {object[]} documents  as the OpenAPI reader returns them
 * @param {{javaFacts:object[], java?:object, registry?:object}} a
 *        the Java records, the Java bridge's own options (so a symbol is written
 *        as that lane writes it), and the rules (the engine's own by default)
 * @returns {{links:number, endpoints:string[], byRule:object, unlinked:object[], alreadyHandled:object[]}|null}
 */
export function addContractLinks(g, documents, { javaFacts, java = {}, registry = null }) {
  const rules = (registry ?? builtinRegistry()).ofKind('java.contract-link');
  if (!Array.isArray(javaFacts) || javaFacts.length === 0) return null;
  const { links, unlinked } = deriveContractLinks(javaFacts, operationsOf(documents), rules);
  if (links.length === 0 && unlinked.length === 0) return null;
  const generating = new Set(documents.filter((d) => d.declaration === GENERATES_CODE).map((d) => d.path));
  return censusOf(placeLinks(g, links, javaSymbolWriter(g, javaFacts, java ?? {}), generating), unlinked);
}

/** What the links drew, per rule, and what a declaration settled. */
function censusOf({ placed, handled }, unlinked) {
  return {
    links: placed.length,
    endpoints: [...new Set(placed.map((l) => l.endpoint))].sort(),
    byRule: byRuleOf(placed, unlinked, handled),
    unlinked,
    alreadyHandled: handled.map((l) => ({ endpoint: l.endpoint, handler: l.handler, rule: l.rule })),
    ...declaredCensus(placed),
  };
}

/**
 * The links that rest on no declaration (`undeclared`), and, when some rest on
 * one, what it settled: the links graded as their method, the routes all of
 * whose links it settled, and the links it could not settle.
 */
function declaredCensus(placed) {
  const declared = placed.filter((l) => l.declared);
  const out = { undeclared: placed.length - declared.length };
  if (declared.length === 0) return out;
  const guessed = new Set(placed.filter((l) => !l.settled).map((l) => l.endpoint));
  const settled = declared.filter((l) => l.settled);
  out.declared = {
    key: GENERATES_CODE, links: settled.length,
    endpoints: [...new Set(settled.map((l) => l.endpoint))].filter((e) => !guessed.has(e)).sort(),
    unsettled: declared.filter((l) => !l.settled).map((l) => ({ endpoint: l.endpoint, handler: l.handler, interface: l.interface })),
  };
  return out;
}
