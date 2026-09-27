// contract_links.mjs — a document's route, joined to the Java method that handles it through an interface only the build generates.
//
// A contract-first project's controllers implement interfaces a code generator
// writes from the OpenAPI document at build time. The Java lane cannot see those
// interfaces, so it sees no mapping, and the OpenAPI bridge puts the document's
// routes on the graph with nothing under them. The `java.contract-link` rules
// (src/core/rules/kinds/java_contract_link.mjs) say which method a generator's
// naming pairs with which operation; this is where their links become HANDLES
// edges, after the document's routes are on the graph.
//
// WHAT IT WRITES, and nothing else: one HANDLES edge per link, from the route
// the document declares to the method, graded as the rule grades it (HEURISTIC:
// the generated interface is never read), with the rule, the operationId, the
// documents and the interface in its evidence. The route node stays the
// document's. A method the rules name without linking it (two routes for one
// operationId, an interface the operation would not be generated into) draws no
// edge and is counted and named in the census instead.

import { builtinRegistry } from '../core/rules/registry.mjs';
import { deriveContractLinks, operationsOf } from '../core/rules/kinds/java_contract_link.mjs';
import { javaSymbolWriter } from './java_bridge.mjs';

/** What every contract link rests on, in one sentence, for `evidence.basis`. */
export const CONTRACT_LINK_BASIS = 'a document declares this operation, and this method\'s class implements an interface the build generates from it, which this analysis never reads: the pairing is the generator\'s naming (the interface named for the operation\'s group, the method for its operationId), a convention and not a fact of the source';

function placeLinks(g, links, writer) {
  let placed = 0;
  for (const l of links) {
    if (!g.nodes.has(l.endpoint)) continue;
    const to = writer(l.handler);
    if (g.outEdges(l.endpoint).some((e) => e.type === 'HANDLES' && e.to === to)) continue;
    g.addEdge({
      from: l.endpoint, to, type: 'HANDLES', grade: l.grade,
      evidence: {
        rule: l.rule, basis: CONTRACT_LINK_BASIS, operationId: l.operationId, documents: l.documents,
        interface: l.interface, generator: l.generator, match: 'operationId',
      },
    });
    placed += 1;
  }
  return placed;
}

/** Per rule: how many links it gave and how many methods it named without one. */
function byRuleOf(links, unlinked) {
  const out = {};
  const row = (id) => { out[id] ??= { links: 0, unlinked: 0 }; return out[id]; };
  for (const l of links) row(l.rule).links += 1;
  for (const u of unlinked) row(u.rule).unlinked += 1;
  return Object.fromEntries(Object.keys(out).sort().map((k) => [k, out[k]]));
}

/**
 * Draw the HANDLES edges the contract rules give. Mutates `g`.
 *
 * Null when no rule gave a link and named nothing, so a project with no
 * contract written this way gets a pack with nothing added to it.
 *
 * @param {import('../core/graph.mjs').Graph} g  a graph the OpenAPI bridge has put the document's routes on
 * @param {object[]} documents  as the OpenAPI reader returns them
 * @param {{javaFacts:object[], java?:object, registry?:object}} a
 *        the Java records, the Java bridge's own options (so a symbol is written
 *        as that lane writes it), and the rules (the engine's own by default)
 * @returns {{links:number, endpoints:string[], byRule:object, unlinked:object[]}|null}
 */
export function addContractLinks(g, documents, { javaFacts, java = {}, registry = null }) {
  const rules = (registry ?? builtinRegistry()).ofKind('java.contract-link');
  if (!Array.isArray(javaFacts) || javaFacts.length === 0) return null;
  const { links, unlinked } = deriveContractLinks(javaFacts, operationsOf(documents), rules);
  if (links.length === 0 && unlinked.length === 0) return null;
  const placed = links.length > 0 ? placeLinks(g, links, javaSymbolWriter(g, javaFacts, java ?? {})) : 0;
  return {
    links: placed,
    endpoints: [...new Set(links.map((l) => l.endpoint))].sort(),
    byRule: byRuleOf(links, unlinked),
    unlinked,
  };
}
