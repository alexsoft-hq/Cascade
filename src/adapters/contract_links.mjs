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
// its evidence. The route node stays the document's. A method the rules name
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

/** The evidence one link's edge carries. */
const linkEvidence = (l) => ({
  rule: l.rule, basis: CONTRACT_LINK_BASIS, operationId: l.operationId, documents: l.documents,
  interface: l.interface, generator: l.generator, match: 'operationId',
});

/** Draw each link that is not already the code's own edge: the links placed, and the ones the code already had. */
function placeLinks(g, links, writer) {
  const placed = [];
  const handled = [];
  for (const l of links) {
    if (!g.nodes.has(l.endpoint)) continue;
    const to = writer(l.handler);
    if (g.outEdges(l.endpoint).some((e) => e.type === 'HANDLES' && e.to === to)) { handled.push(l); continue; }
    g.addEdge({ from: l.endpoint, to, type: 'HANDLES', grade: l.grade, evidence: linkEvidence(l) });
    placed.push(l);
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
  const { placed, handled } = placeLinks(g, links, javaSymbolWriter(g, javaFacts, java ?? {}));
  return {
    links: placed.length,
    endpoints: [...new Set(placed.map((l) => l.endpoint))].sort(),
    byRule: byRuleOf(placed, unlinked, handled),
    unlinked,
    alreadyHandled: handled.map((l) => ({ endpoint: l.endpoint, handler: l.handler, rule: l.rule })),
  };
}
