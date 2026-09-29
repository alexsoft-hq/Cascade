// typeorm_path.mjs — what goes before a TypeORM table name: the schema, the database, both or nothing, as the application's driver builds a table path.
//
// EntityMetadata.build hands the driver the table name, the entity's schema
// (its own, else the DataSource's) and its own database, and the driver's
// buildTableName decides which of them qualify the table: PostgreSQL the
// schema, MySQL the database, SQL Server both, SQLite neither. WHICH driver
// uses which is the rule pack's (`tablePath`, src/core/rules/packs/typeorm.json);
// how a path is joined, as TypeORM joins it, is here.
//
// SQLite's drivers take an entity's database as a file to attach, and put a
// handle they make from its path before the table name (0.3.28
// SqliteDriver.buildTableName): the pack writes that part `attached`, and a
// table of an entity that names a database there is not EXACT, since the
// handle is not made here.
//
// The driver is the DataSource's `type`. When it is not known, what qualifies
// a table is not known either, unless nothing could (no schema anywhere, no
// database of the entity's own): then the table stands alone whatever the
// driver, and nothing is doubted. A schema the profile declares is the
// qualifier as declared.

import { isPlainObject } from './ts_names.mjs';

const PARTS = Object.freeze(['schema', 'database', 'attached']);

/** Everything wrong with `params.tablePath`: a driver's type as TypeORM names it, to the parts that qualify its tables, in order. */
export function tablePathErrors(tp) {
  if (!isPlainObject(tp) || Object.keys(tp).length === 0) return ['params.tablePath must map each driver type to the parts that go before its table names'];
  return Object.entries(tp).filter(([, parts]) => !Array.isArray(parts) || !parts.every((p) => PARTS.includes(p)) || new Set(parts).size !== parts.length)
    .map(([type]) => `params.tablePath.${type} must list parts from ${PARTS.join(', ')}, each once`);
}

/**
 * The parts that qualify a table, and the doubts on them, from the driver the
 * decision knows or the lack of it; `driver` is the doubt the driver itself
 * leaves, when it leaves one, so the run can say what to declare.
 */
function partsOf(decision, tablePath, own) {
  if (decision.declared?.includes('schema') && own.schema == null && own.database == null) return { parts: ['schema'], doubts: [] };
  const parts = decision.typeKnown ? tablePath[decision.type] : null;
  if (parts) return { parts, doubts: [] };
  const driver = driverDoubt(decision, own);
  return { parts: ['schema'], doubts: driver ? [driver] : [], ...(driver ? { driver } : {}) };
}

/** Why the driver leaves a table's qualifier in doubt: one the pack does not name, or none known where a schema or a database could qualify it. */
function driverDoubt(decision, own) {
  if (decision.typeKnown) return `the driver ${decision.type} is not one whose table path the typeorm pack names`;
  const anything = own.schema || own.database || !decision.schemaKnown || decision.schema;
  return anything ? `the DataSource type, which decides whether a schema or a database goes before a table name, is not known: ${decision.typeWhy}` : null;
}

/** A SQLite driver's attached database: a handle it makes goes before the table name. */
const attachedDoubt = (decision, own) => `the driver ${decision.type} attaches the database file ${own.database} under a handle it makes from the path, which goes before the table name and is not made here`;

/**
 * The qualifier of one table and the doubts on it: `own` is what the entity
 * (or the join table) writes itself, `{schema, database}`. The qualifier is
 * the path TypeORM builds without the table's own name: `billing`, `app`,
 * `app.dbo`, or `app.` for a SQL Server database with no schema, as its
 * buildTableName joins one; '' when nothing qualifies it.
 */
export function pathOf(decision, tablePath, own) {
  const { parts, doubts, driver } = partsOf(decision, tablePath, own);
  doubts.push(...partDoubts(decision, parts, own));
  const schema = own.schema ?? (decision.schemaKnown ? decision.schema : '');
  const values = parts.map((p) => (p === 'schema' ? schema : p === 'database' ? own.database : '') ?? '');
  const first = values.findIndex(Boolean);
  return { qualifier: first < 0 ? '' : values.slice(first).join('.'), doubts, ...(driver ? { driver } : {}) };
}

/** What the parts of a path leave in doubt: a schema the options do not settle, a database a SQLite driver attaches under its own handle. */
function partDoubts(decision, parts, own) {
  const out = [];
  if (parts.includes('schema') && own.schema == null && !decision.schemaKnown) out.push(`the DataSource schema, the schema of an entity that names none, is not known: ${decision.schemaWhy}`);
  if (parts.includes('attached') && own.database) out.push(attachedDoubt(decision, own));
  return out;
}
