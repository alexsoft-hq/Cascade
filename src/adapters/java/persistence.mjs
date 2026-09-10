// persistence.mjs — where a Java method meets the SQL the pack already holds.
//
// WHAT THIS MODULE OWNS. The last hop of the chain and the two things beside it:
//   IMPLEMENTS_STMT   a MyBatis statement id IS the mapper interface FQN plus
//                     the method name, so the edge is definitional and EXACT.
//                     A method whose statement is NOT in this pack gets no edge
//                     and is COUNTED — a stub statement node would be a fact the
//                     engine never saw.
//   …and the OTHER    a DAO that has no mapper interface at all NAMES the
//   MyBatis shape     statement in the call, `selectList("Ns.id", vo)`. That
//                     literal is the key MyBatis looks it up by, so that edge is
//                     definitional too. The one thing the rule DECIDES is that
//                     the receiver is a MyBatis session, and it reads that off
//                     the declared type or the `extends` chain.
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
import {
  cmp, memberToStatementKey, namespaceOfStatementKey, ownerOf, resolveInheritedField,
  SUPER_CHAIN_LIMIT,
} from './types.mjs';

/**
 * THE TYPES A STATEMENT ID CAN BE CALLED ON, by simple name.
 *
 * `selectList("CmmnCodeManageDAO.selectCmmnCodeList", vo)` runs a statement
 * only when the receiver is a MyBatis SESSION. These five are what a Java
 * project can be holding when it writes that line: the two MyBatis interfaces,
 * the Spring template, the Spring DAO base, and the eGovFrame base every
 * Korean public sector DAO extends — which is `SqlSessionDaoSupport` with the
 * ten methods put back on top of it.
 *
 * Matched by SIMPLE NAME up the whole `extends` chain, because the base is
 * almost never a class the run parsed: `EgovAbstractMapper` ships in a jar, and
 * the only thing the tree says about it is the import line and the `extends`
 * clause. Both are enough — a class that extends a type of that name IS one.
 */
export const MYBATIS_SESSION_TYPES = Object.freeze([
  'SqlSession', 'SqlSessionTemplate', 'SqlSessionDaoSupport',
  'EgovAbstractMapper', 'EgovComAbstractDAO',
]);

/** How many statement-id call sites a census lists by name before it stops. */
export const STATEMENT_ID_SAMPLE_LIMIT = 20;

/** What the `mybatis-statement-id` edge rests on, in one sentence. */
export const STATEMENT_ID_BASIS = 'the first argument of a MyBatis session call is the statement\'s RUNTIME KEY: MyBatis looks the statement up by exactly this string, and the mapper XML declares it as its namespace plus its id. The literal is read from the source and matched against a statement this pack already holds, so nothing here was resolved or guessed. What the rule does decide is that the receiver is a MyBatis session, which it reads off the declared type or the `extends` chain';


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


/**
 * WHICH TYPES ARE A MYBATIS SESSION, by walking each type's `extends` chain and
 * asking whether any link is one of `MYBATIS_SESSION_TYPES` by simple name.
 *
 * The chain is walked over SIMPLE names, not resolved FQNs, and it has to be:
 * `EgovAbstractMapper` is in a jar this run never parsed, so `superOf` gives it
 * no record and the walk would stop one link before the answer. What the tree
 * DOES say is `class BBSAttributeManageDAO extends EgovAbstractMapper`, and
 * that clause is the whole evidence.
 *
 * @returns {Set<string>} the FQNs whose instances can be handed a statement id
 */
export function sessionTypesOf(ctx) {
  const { types, superOf } = ctx;
  const bases = new Set(MYBATIS_SESSION_TYPES);
  const simpleOf = (fqn) => fqn.slice(Math.max(fqn.lastIndexOf('.'), fqn.lastIndexOf('$')) + 1);
  const out = new Set();
  for (const [fqn, t] of types) {
    let cur = fqn;
    let record = t;
    for (let hops = 0; hops <= SUPER_CHAIN_LIMIT && record; hops += 1) {
      const ext = record.extendsSimple;
      if (!ext) break;
      if (bases.has(ext)) { out.add(fqn); break; }
      const next = superOf.get(cur) ?? null;
      if (!next || next === cur) break;
      cur = next;
      record = types.get(next) ?? null;
    }
    if (bases.has(simpleOf(fqn))) out.add(fqn);
  }
  return out;
}

/**
 * A STATEMENT CALLED BY ITS STRING ID (RM55).
 *
 * `IMPLEMENTS_STMT` above binds a mapper INTERFACE METHOD to the statement of
 * the same name, which is the shape MyBatis has documented since 3.0 and the
 * shape every project in the corpus used — until the corpus grew. eGovFrame
 * does not write mapper interfaces at all: its DAOs extend a session base and
 * name the statement outright,
 * `selectList("CmmnDetailCodeManageDAO.selectCmmnDetailCodeList", vo)`, 1,288
 * times in the common components alone. Before this rule, 219 routes and 205
 * statements in one of those repositories shared not a single edge.
 *
 * EXACT, and for the same reason the interface rule is: the literal IS the key
 * MyBatis looks the statement up by at run time, and the mapper XML declares
 * that key as its namespace plus the statement id. There is nothing between
 * them to resolve. The one thing the rule DECIDES is that the receiver is a
 * session, and it decides that from the declared type or the `extends` chain.
 *
 * WHAT IT REFUSES. A literal that names no statement THIS PACK HOLDS gets no
 * edge — a stub statement node would be a fact the engine never saw — and is
 * listed by name (`STATEMENT_ID_UNKNOWN`), because a mapper XML left outside
 * the run and a typo look the same from here and only a reader can tell them
 * apart. A first argument no single file can read (a parameter, a
 * concatenation) is counted with a sample of what was written.
 */
/**
 * WHAT THE OBJECT AT THIS CALL SITE IS, as far as the type records say.
 *
 * An unqualified call (`selectList(…)`, `this.` or `super.`) runs on the
 * enclosing object, so the question is what the ENCLOSING class extends. A call
 * through a field asks the same question of the field's declared type, which is
 * how a DAO that HOLDS a `SqlSessionTemplate` rather than extending one is
 * read. A receiver the file never declares is looked for in an ancestor's
 * fields, the same walk the call rules use.
 *
 * @returns {string|null} the receiver's type, as an FQN or a simple name
 */
function statementCallReceiver(ctx, c) {
  const { types, superOf, fieldsByOwner, resolveType } = ctx;
  const ownerFqn = ownerOf(c.from);
  const spelling = c.via ?? 'field';
  if (spelling === 'unqualified' || spelling === 'this-method' || spelling === 'super-method') return ownerFqn;
  if (spelling === 'identifier') {
    const found = resolveInheritedField(ownerFqn, c.receiver, { types, superOf, fieldsByOwner, resolveType });
    if (!found) return null;
    return found.typeFqn ?? found.typeSimple ?? null;
  }
  return resolveType(ownerFqn, c.toTypeSimple) ?? c.toTypeSimple ?? null;
}

/** One recognised session call: an edge, an unknown id, or an unreadable argument. */
function placeStatementId(ctx, c, { unknown, seen }) {
  const { g, stats, ensureSymbol } = ctx;
  const census = stats.statementIds;
  census.sites += 1;
  if (c.stmtId === null) {
    census.unreadable += 1;
    if (census.unreadableSamples.length < STATEMENT_ID_SAMPLE_LIMIT) {
      census.unreadableSamples.push({ from: c.from, method: c.method, wrote: c.stmtArg, file: c.file, line: c.line });
    }
    return;
  }
  if (c.stmtIdFrom === 'constant') census.fromConstant += 1;
  const stmtNodeId = nodeId('statement', c.stmtId);
  if (!g.nodes.has(stmtNodeId)) {
    census.unknown += 1;
    const hit = unknown.get(c.stmtId);
    if (hit) hit.sites += 1;
    else unknown.set(c.stmtId, { id: c.stmtId, sites: 1, from: c.from, file: c.file, line: c.line });
    return;
  }
  const key = `${c.from} ${c.stmtId}`;
  if (seen.has(key)) { census.repeated += 1; return; }
  seen.add(key);
  g.addEdge({
    from: ensureSymbol(c.from), to: stmtNodeId, type: 'IMPLEMENTS_STMT', grade: 'EXACT',
    evidence: {
      rule: 'mybatis-statement-id',
      basis: STATEMENT_ID_BASIS,
      statement: c.stmtId,
      from: c.stmtIdFrom,
      receiver: c.receiver ?? null,
      ...(c.line != null ? { line: c.line } : {}),
    },
  });
  census.bound += 1;
  stats.implementsStmt += 1;
}

export function bindStatementIds(ctx) {
  const { stats, calls } = ctx;
  const sessions = sessionTypesOf(ctx);
  const bases = new Set(MYBATIS_SESSION_TYPES);
  const unknown = new Map(); // statement id -> {id, sites, from, file, line}
  const seen = new Set(); // "member -> statement": one method calling one statement twice is one edge
  const isSession = (fqn) => typeof fqn === 'string'
    && (sessions.has(fqn) || bases.has(fqn.slice(fqn.lastIndexOf('.') + 1)));
  for (const c of calls) {
    if (!c.from || (c.stmtId === null && c.stmtArg === null)) continue;
    if (!isSession(statementCallReceiver(ctx, c))) continue;
    placeStatementId(ctx, c, { unknown, seen });
  }
  stats.statementIds.unknownSamples = [...unknown.values()]
    .sort((a, b) => (b.sites - a.sites) || cmp(a.id, b.id))
    .slice(0, STATEMENT_ID_SAMPLE_LIMIT);
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

