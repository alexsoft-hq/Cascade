// persistence.mjs — where a Java method meets the SQL the pack already holds.
//
// WHAT THIS MODULE OWNS. The last hop of the chain and the two things beside it:
//   IMPLEMENTS_STMT   a MyBatis statement id IS the mapper interface FQN plus
//                     the method name, so the edge is definitional and EXACT.
//                     A method whose statement is NOT in this pack gets no edge
//                     and is COUNTED — a stub statement node would be a fact the
//                     engine never saw.
//   the mapper census which owner types are mappers at all, from two independent
//                     witnesses, so the count works in a pack that has only one
//                     of the two lanes.
//   the transactions  the @Transactional boundary marked on its own symbol. The
//                     read/write footprint is computed at QUERY time by forward
//                     reach from that node (SPEC §9), never stored.
//
// WHAT IT MUST NEVER KNOW ABOUT: how a call was resolved, what a route is, or
// what SQL a statement runs. It reads the statement NODES the SQL bridge already
// put on the graph and matches them by name; the SQL is the SQL lane's business.

import { nodeId } from '../../core/graph.mjs';
import { memberToStatementKey, namespaceOfStatementKey, ownerOf } from './types.mjs';


/**
 * Every method record becomes a symbol node BEFORE the binding below, so an
 * uncalled mapper method still binds: `table_usage` sees every mapper method,
 * not only the reachable ones.
 */
export function registerMethodSymbols(ctx) {
  const { methods, ensureSymbol } = ctx;
  // Register method records as symbols first so uncalled mapper methods still
  // bind (table_usage sees every mapper method, not only reachable ones).
  for (const m of methods) ensureSymbol(m.fqn);
}


/**
 * Which owner types are MyBatis mappers at all.
 * @returns {Set<string>}
 */
export function mapperOwnersOf(ctx) {
  const { g, types } = ctx;
  // Which owner types are MyBatis mappers at all. Two independent witnesses, so
  // the census works in a pack that has only one of the two lanes:
  //   - a type whose FQN is the namespace of a statement THIS pack carries;
  //   - a type the source annotates @Mapper (the only witness a java-only pack has).
  const mapperOwners = new Set();
  for (const id of g.nodes.keys()) {
    if (!id.startsWith('statement:')) continue;
    const ns = namespaceOfStatementKey(id.slice('statement:'.length));
    if (ns) mapperOwners.add(ns);
  }
  for (const [fqn, t] of types) {
    if ((t.annotations ?? []).includes('Mapper')) mapperOwners.add(fqn);
  }
  return mapperOwners;
}


/** The IMPLEMENTS_STMT edges, and the mapper methods that found no statement. */
export function bindStatements(ctx, mapperOwners) {
  const { g, stats } = ctx;
  for (const [id, node] of g.nodes) {
    if (node.kind !== 'symbol') continue;
    const memberFqn = id.slice('symbol:'.length);
    const stmtNodeId = nodeId('statement', memberToStatementKey(memberFqn));
    const isMapperMethod = mapperOwners.has(ownerOf(memberFqn));
    if (isMapperMethod) {
      // Marked on the node so `cascade estimate` can measure "how many mapper
      // methods actually bind to SQL" from the pack alone, with no lane stats.
      node.mapperMethod = true;
      stats.mapperMethods += 1;
    }
    if (g.nodes.has(stmtNodeId)) {
      g.addEdge({ from: id, to: stmtNodeId, type: 'IMPLEMENTS_STMT', grade: 'EXACT' });
      stats.implementsStmt += 1;
      if (isMapperMethod) stats.mapperMethodsBound += 1;
    } else if (isMapperMethod) {
      // The statement this method would run is not in this pack (the SQL lane
      // was not run, or its mapper XML was outside the analyzed directories).
      // DELIBERATE CHOICE: skip the edge — a stub statement node would be a
      // fact the engine never saw. It is counted here instead, and `overview`
      // and `estimate` report the count so the gap is visible, not silent.
      stats.unboundMapperMethods += 1;
    }
  }
}


/** The @Transactional boundaries, marked on their own symbols. */
export function markTransactions(ctx) {
  const { g, stats, transactionals, ensureSymbol } = ctx;
  // Mark transaction boundaries on their symbol nodes (create if the method was
  // never otherwise referenced). The read/write footprint is computed at query
  // time by forward reach from the node (SPEC §9: a transaction's atomic set).
  for (const tx of transactionals) {
    const id = ensureSymbol(tx.method);
    const n = g.nodes.get(id);
    n.transactional = true;
    n.txScope = tx.scope;
    if (n.line == null && tx.line != null) n.line = tx.line;
    stats.transactional += 1;
  }
}

