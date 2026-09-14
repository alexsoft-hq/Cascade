// idgnr.mjs — the eGovFrame table id generator, as the table it reads and writes (RM62).
//
// WHAT THIS MODULE OWNS. A service that inserts a row asks a bean for the key:
//
//     @Resource(name = "egovIdGnrService")
//     private EgovIdGnrService egovIdGnrService;
//     …
//     String id = egovIdGnrService.getNextStringId();
//
// The bean is `EgovTableIdGnrServiceImpl`, declared in a Spring XML, and it
// hands the key out by reading and advancing a row of its OWN table. So the
// service writes that table too, and no mapper says so. A real run of the
// eGovFrame web sample showed it: `POST /addSample.do` touched `SAMPLE` and
// `IDS`, and the pack knew only `SAMPLE`.
//
// HOW IT IS READ, in two halves that meet in the graph:
//   the SQL      the two statements the class runs, written from the bean's
//                properties, go through the SQL lane like any other statement,
//                so the table and its columns are that lane's facts
//   the call     a call on a field injected BY NAME, whose name is one of those
//                beans, to one of the class's `getNext…Id` methods, binds the
//                caller to a symbol of that bean, and that symbol to the two
//                statements
//
// Every bean has its own symbol. The interface method every one of them shares
// (`EgovIdGnrService#getNextStringId`) is left as the call the source states,
// because a table hung on it would hand every generator's table to every caller.
//
// WHAT IT MUST NEVER KNOW ABOUT: the XML itself (`src/core/springconfig.mjs`
// reads it), the SQL grammar (the SQL lane parses the statements), the runtime.

import { nodeId } from '../../core/graph.mjs';

/** The evidence rule of every edge this module writes. */
export const ID_GENERATOR_RULE = 'egov-id-generator';

/** The methods of `EgovIdGnrService` that allocate a key, and so run the SQL. */
export const ID_GENERATOR_METHOD_RE = /^getNext(?:String|Integer|Long|BigDecimal|Byte|Short)Id$/;

/** What an edge of this rule rests on, in the house voice. */
export const ID_GENERATOR_BASIS = 'the field is injected by name, that name is an `EgovTableIdGnrServiceImpl` bean a Spring XML of this project declares, and the method called allocates a key. The class allocates it by reading and advancing a row of the table the bean names, so the caller reads and writes that table. SOUND_SET and not EXACT: this reads the bean name the field asks for, without the container that would settle a profile or a bean defined twice';

/** The namespace of the two statements one bean runs. */
const namespaceOf = (bean) => `egov-idgnr.${bean}`;

/**
 * THE TWO STATEMENTS one generator runs, in the shape the SQL lane takes.
 *
 * The text is the class's own, as a run of the eGovFrame web sample recorded
 * it: `SELECT next_id FROM IDS WHERE table_name = ? FOR UPDATE`, then
 * `UPDATE IDS SET next_id = ? WHERE table_name = ?`, with the table and the
 * two column names the bean sets or the class defaults to. A bean declared
 * twice under one name is one generator: the first in bean, file, line order.
 *
 * @param {{bean:string, table:string, keyColumn:string, nextIdColumn:string, file:string, line:number}[]} generators
 * @returns {{kind:string, namespace:string, id:string, type:string, sql:string, file:string, line:number}[]}
 */
export function idGeneratorStatements(generators) {
  const out = [];
  for (const gen of firstPerBean(generators)) {
    const { table, keyColumn, nextIdColumn } = gen;
    out.push(
      {
        kind: 'statement', namespace: namespaceOf(gen.bean), id: 'allocate', type: 'select',
        sql: `SELECT ${nextIdColumn} FROM ${table} WHERE ${keyColumn} = ? FOR UPDATE`,
        file: gen.file, line: gen.line,
      },
      {
        kind: 'statement', namespace: namespaceOf(gen.bean), id: 'advance', type: 'update',
        sql: `UPDATE ${table} SET ${nextIdColumn} = ? WHERE ${keyColumn} = ?`,
        file: gen.file, line: gen.line,
      },
    );
  }
  return out;
}

/** One generator per bean name, the first by bean, file and line. */
function firstPerBean(generators) {
  const byBean = new Map();
  const sorted = (Array.isArray(generators) ? generators : [])
    .filter((g) => g && typeof g.bean === 'string' && g.bean !== '')
    .slice()
    .sort((a, b) => (a.bean < b.bean ? -1 : a.bean > b.bean ? 1 : a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
  for (const g of sorted) if (!byBean.has(g.bean)) byBean.set(g.bean, g);
  return [...byBean.values()];
}

/** An empty census of this rule, the shape the Java lane's stats carry. */
export function emptyIdGeneratorCensus() {
  return { declared: 0, sites: 0, bound: 0, notABean: 0, noStatement: 0, repeated: 0 };
}

/**
 * The bean a field of this class, or of a class it extends, asks for by name.
 *
 * An eGovFrame service usually declares its generator itself, and the lookup
 * climbs the `extends` chain for the one that inherits it.
 */
function beanNameOf(ctx, owner, field) {
  const { beanNamesByOwner, superOf } = ctx;
  const seen = new Set();
  for (let at = owner; at && !seen.has(at); at = superOf?.get(at) ?? null) {
    seen.add(at);
    const name = beanNamesByOwner?.get(at)?.get(field);
    if (typeof name === 'string' && name !== '') return name;
  }
  return null;
}

/** The symbol one bean's allocation is, created once with the bean's own facts on it. */
function generatorSymbol(g, gen, method) {
  const member = `${gen.className}@${gen.bean}#${method}`;
  const id = nodeId('symbol', member);
  if (!g.nodes.has(id)) {
    g.addNode({
      id, symbol: member, owner: `${gen.className}@${gen.bean}`, file: gen.file, line: gen.line,
      external: true,
      idGenerator: { bean: gen.bean, table: gen.table, key: gen.key },
    });
  }
  return id;
}

/**
 * THE CALLS THAT ALLOCATE A KEY, bound to the table the generator advances.
 *
 * @param {object} ctx  the Java bridge context: `g`, `stats`, `calls`, `ensureSymbol`,
 *                      `beanNamesByOwner`, `superOf`
 * @param {object[]} generators  `findIdGenerators` records
 */
export function bindIdGenerators(ctx, generators = []) {
  const { g, stats, calls, ensureSymbol } = ctx;
  const census = stats.idGenerators;
  const byBean = new Map(firstPerBean(generators).map((gen) => [gen.bean, gen]));
  census.declared = byBean.size;
  if (byBean.size === 0) return;
  const seen = new Set();
  for (const c of calls ?? []) {
    if (!c || !c.from || c.via !== 'field' || !ID_GENERATOR_METHOD_RE.test(c.method ?? '')) continue;
    const owner = c.from.slice(0, c.from.indexOf('#'));
    const bean = beanNameOf(ctx, owner, c.receiver);
    if (bean === null) continue;
    census.sites += 1;
    const gen = byBean.get(bean);
    if (!gen) { census.notABean += 1; continue; }
    const statements = ['allocate', 'advance'].map((id) => nodeId('statement', `${namespaceOf(bean)}.${id}`));
    if (!statements.every((s) => g.nodes.has(s))) { census.noStatement += 1; continue; }
    const key = `${c.from} ${bean} ${c.method}`;
    if (seen.has(key)) { census.repeated += 1; continue; }
    seen.add(key);
    const target = generatorSymbol(g, gen, c.method);
    g.addEdge({
      from: ensureSymbol(c.from), to: target, type: 'MAY_CALL', grade: 'SOUND_SET',
      evidence: { rule: ID_GENERATOR_RULE, basis: ID_GENERATOR_BASIS, bean, table: gen.table, key: gen.key },
    });
    for (const s of statements) {
      if (g.outEdges(target).some((e) => e.type === 'IMPLEMENTS_STMT' && e.to === s)) continue;
      g.addEdge({
        from: target, to: s, type: 'IMPLEMENTS_STMT', grade: 'EXACT',
        evidence: { rule: ID_GENERATOR_RULE, bean },
      });
    }
    census.bound += 1;
  }
}
