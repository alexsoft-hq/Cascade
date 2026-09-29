// remedies.mjs — the one thing a reader can do about a gap, a lane's diagnostic or an axis that is not whole (RM67-U2d).
//
// WHY. A gap used to say what the run could not read and stop there. The key
// that would have let it read was in a sentence on another page, or in words
// the viewer wrote for itself: ghostfolio showed 0% on every card because 117 of
// its 118 routes were guesses, and the one profile key that makes them sure was
// named only on Analysis status. So the overview carries, beside every gap,
// diagnostic and axis that is not whole, the one thing to do, as DATA:
//
//   {action:'declare', key, example}   a profile key, with a short example value
//   {action:'flag', flag, example}     a `cascade analyze` flag, with its argument
//   {action:'run', command}            a command to run
//   {action:'mode', mode}              the mode to ask in
//   null                               the engine knows no single fix
//
// A kind whose cause differs from one instance to the next (MISSING_INPUT says
// five different things) is null rather than the fix for one of them.
//
// WHAT IT MUST NEVER DO: name a key, a flag or a command the engine does not
// have. test/remedies.test.mjs holds every key to the profile validator (with
// its example), every flag to `cascade analyze`'s usage, every command to the
// CLI, every kind to a line that emits it, and each diagnostic's key to the
// sentence the diagnostic already says.

import { GRADE_SETS } from './graph.mjs';

/** A short example value per profile key a remedy declares, as the profile file holds it. */
export const REMEDY_EXAMPLES = Object.freeze({
  'tsBackend.globalPrefixExclude': '["health", "docs{/*rest}"]',
  'tsBackend.globalPrefix': '"api"',
  'tsBackend.app': '"apps/api/src"',
  // The driver is in it (review 4, S-2): a catalog degraded because the driver is not known is fixed here too.
  'tsBackend.typeorm': '{ "namingStrategy": "snake", "entityPrefix": "", "type": "postgres" }',
  'jpa.namingStrategy': '"spring-snake-case"',
  'mybatisPlus.namingStrategy': '"underscore"',
  pathPrefixes: '[{ "prefix": "/admin-api", "packages": "**.controller.admin.**" }]',
  gatewayRoutes: '{ "/dev-api": "" }',
  servers: '{ "mall-admin": { "port": 8080 } }',
  'openapi.generatedFromCode': '["../docs/openapi.json"]',
  'openapi.generatesCode': '["../src/main/resources/openapi.yml"]',
  // The whole map, not `sqlDialects.main`: a key of the profile is what the validator takes, and main is the one key it routes.
  sqlDialects: '{ "main": "postgres" }',
});

/** The narrowest to the widest: a wider mode admits every grade a narrower one does. */
const MODES = Object.freeze(['strict', 'conservative', 'heuristic']);
/** A mode remedy's `mode`: the next wider one. Any other value is the grade the mode must admit. */
const WIDER = 'next';

const CATALOG_FETCH = Object.freeze({ action: 'run', command: 'cascade catalog fetch --candidate 1' });
const JAVA_SRC = Object.freeze({ action: 'flag', flag: '--java-src', example: '--java-src <dir>' });

/**
 * Per gap kind. `when` names a laneStats count that must be above zero for the
 * remedy to hold: of the calls a lane could not place, only the ones into a
 * package no source root holds are fixed by passing that root. `otherwise` is
 * the remedy when that count is not: a contract link on a document no
 * declaration covers is settled by declaring it, and one a declaration could
 * not settle (its interface's name depends on a setting not read) is walked
 * only in the mode that admits it.
 */
export const GAP_REMEDIES = Object.freeze({
  'no-catalog': CATALOG_FETCH,
  'not-shipped': JAVA_SRC,
  'http-calls-leaving-pack': { action: 'run', command: 'cascade init --root <the project that serves them>' },
  'unresolved-calls': { action: 'flag', flag: '--java-src', example: '--java-src <module>/src/main/java', when: ['unresolvedCallsByReason', 'project-type-outside-roots'] },
  'mode-floor': { action: 'mode', mode: WIDER },
  'contract-links': {
    action: 'declare', key: 'openapi.generatesCode', when: ['openapi', 'contractLinks', 'undeclared'],
    otherwise: { action: 'mode', mode: 'HEURISTIC' },
  },
  'catalog-rules-assumed': { action: 'declare', key: 'sqlDialects' },
});

/**
 * Per diagnostic kind. `key: null` is the diagnostic's own `key` (a setting a
 * rule pack names); `routes: true` marks the diagnostic that grades the routes'
 * own addresses, so the routes that are guesses carry its fix.
 */
export const DIAGNOSTIC_REMEDIES = Object.freeze({
  TS_PREFIX_EXCLUDE_UNREAD: { action: 'declare', key: 'tsBackend.globalPrefixExclude', routes: true },
  TS_PREFIX_UNREAD: { action: 'declare', key: 'tsBackend.globalPrefix' },
  TS_TYPEORM_NAMING_ASSUMED: { action: 'declare', key: 'tsBackend.typeorm' },
  TS_APPS_FOUND: { action: 'declare', key: 'tsBackend.app' },
  JPA_NAMING_UNREADABLE: { action: 'declare', key: 'jpa.namingStrategy' },
  DISCOVERY_CAPPED: { action: 'flag', flag: '--ts-src', example: '--ts-src <the application root>' },
  SETTING_IN_CODE: { action: 'declare', key: null },
  PREFIX_NOT_ON_CALLS: { action: 'declare', key: null },
  ROUTE_MOUNT_FROM_DOCUMENT: { action: 'declare', key: 'openapi.generatedFromCode', routes: true },
  CONTRACT_FROM_DOCUMENT: { action: 'declare', key: 'openapi.generatesCode', routes: true },
  CATALOG_RULE_ASSUMED: { action: 'declare', key: 'sqlDialects' },
  CATALOG_COLUMN_UNNAMED: { action: 'declare', key: 'sqlDialects' },
});

/**
 * Per axis and state. `follows` is an axis this state is the consequence of:
 * columns read in part because no schema was read are fixed by the schema.
 * `onlyCauses` holds a fix only when every cause the axis names (`causes`) is
 * one of these: a web axis degraded by nothing but a port on this machine no
 * file states is made whole by declaring that port, and one degraded by
 * anything else has no single fix. A list is one fix per cause, the first whose
 * causes hold (RM67-C6): a catalog degraded by an assumed database is fixed by
 * declaring it, one degraded by TypeORM names by the TypeORM settings, one that
 * lost tables by nothing the engine knows, and one with two causes by no one fix.
 */
export const AXIS_REMEDIES = Object.freeze({
  'catalog:not-shipped': CATALOG_FETCH,
  'catalog:degraded': [
    { action: 'declare', key: 'tsBackend.typeorm', onlyCauses: ['typeorm-names-heuristic'] },
    { action: 'declare', key: 'sqlDialects', onlyCauses: ['rules-assumed'] },
  ],
  'statements:not-shipped': { action: 'flag', flag: '--mappers', example: '--mappers <dir>' },
  'code:not-shipped': JAVA_SRC,
  'web:not-shipped': { action: 'flag', flag: '--web-src', example: '--web-src <dir>' },
  'web:degraded': { action: 'declare', key: 'servers', onlyCauses: ['port-default', 'port-unknown'] },
  'jpa:degraded': { action: 'declare', key: 'jpa.namingStrategy' },
  'mybatisPlus:degraded': { action: 'declare', key: 'mybatisPlus.namingStrategy' },
  'column:degraded': { follows: ['catalog', 'jpa', 'mybatisPlus'] },
  'screen:not-shipped': { follows: ['web'] },
});

/** The narrowest mode wider than `mode` that admits `grade`, or the next wider one; null when none does. */
function modeFor(mode, want) {
  const wider = MODES.slice(MODES.indexOf(mode) + 1);
  const hit = want === WIDER ? wider[0] : wider.find((m) => GRADE_SETS[m].has(want));
  return hit ? { action: 'mode', mode: hit } : null;
}

/** One table entry as the answer carries it: the fields a reader acts on, and null for what cannot be said. */
function resolve(entry, { mode = 'conservative', key = null } = {}) {
  // An entry that only `follows` another axis has no fix of its own.
  if (!entry || !entry.action) return null;
  if (entry.action === 'mode') return modeFor(mode, entry.mode);
  if (entry.action === 'declare') {
    const k = entry.key ?? key;
    return k && Object.hasOwn(REMEDY_EXAMPLES, k) ? { action: 'declare', key: k, example: REMEDY_EXAMPLES[k] } : null;
  }
  if (entry.action === 'flag') return { action: 'flag', flag: entry.flag, example: entry.example };
  return entry.action === 'run' ? { action: 'run', command: entry.command } : null;
}

/** Is the laneStats count a remedy depends on above zero? */
function holds(when, laneStats) {
  if (!when) return true;
  const n = when.reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), laneStats);
  return Number.isInteger(n) && n > 0;
}

/**
 * THE REMEDY OF ONE GAP, or null.
 * @param {string} kind
 * @param {{mode?:string, laneStats?:object|null}} o  the census the gap was said from
 */
export function gapRemedy(kind, o = {}) {
  const entry = GAP_REMEDIES[kind];
  if (!entry) return null;
  return holds(entry.when, o.laneStats) ? resolve(entry, { mode: o.mode }) : resolve(entry.otherwise, { mode: o.mode });
}

/** THE REMEDY OF ONE DIAGNOSTIC, or null. */
export function diagnosticRemedy(d) {
  return resolve(DIAGNOSTIC_REMEDIES[d && d.kind], { key: d && d.key });
}

/** Whether an axis entry's fix holds for this axis: always, or, with `onlyCauses`, when every cause it names is one of them. */
function causedOnlyBy(entry, axis) {
  if (!entry || !entry.onlyCauses) return true;
  const causes = axis && Array.isArray(axis.causes) ? axis.causes : [];
  return causes.length > 0 && causes.every((c) => entry.onlyCauses.includes(c));
}

/** An axis state's fix: the first alternative whose causes hold for this axis, resolved; null when none does. */
function fixFor(entry, axis) {
  const found = [].concat(entry ?? []).find((e) => causedOnlyBy(e, axis));
  return found ? resolve(found) : null;
}

/**
 * A remedy per axis that is not whole (degraded or not-shipped), null where the
 * engine knows none. A whole axis has no entry.
 * @param {Object|null} axes  the pack's own axis declaration
 */
export function axisRemedies(axes) {
  const out = {};
  const statusOf = (axis) => axes && axes[axis] && axes[axis].status;
  const broken = (axis) => ['degraded', 'not-shipped'].includes(statusOf(axis));
  const own = (axis) => fixFor(AXIS_REMEDIES[`${axis}:${statusOf(axis)}`], axes[axis]);
  for (const axis of Object.keys(axes || {}).filter(broken)) {
    const entry = AXIS_REMEDIES[`${axis}:${statusOf(axis)}`];
    const from = entry && entry.follows ? entry.follows.find((x) => broken(x) && own(x)) : null;
    out[axis] = from ? own(from) : own(axis);
  }
  return out;
}

/**
 * THE ROUTES WHOSE OWN ADDRESS IS A GUESS (a HANDLES edge below SOUND_SET): the
 * fix a diagnostic that grades routes names, else the mode that walks them,
 * else null. Null too when no route is a guess.
 * @param {Object<string,number>} routeGrades  `reach.routeGrades`
 * @param {string} mode  the census mode
 * @param {{kind:string, key?:string}[]} diagnostics  the run's diagnostics
 */
export function routeRemedy(routeGrades, mode, diagnostics) {
  const guessed = ['HEURISTIC', 'RUNTIME_ONLY', 'UNRESOLVED'].filter((g) => (routeGrades?.[g] ?? 0) > 0);
  if (guessed.length === 0) return null;
  const diag = (diagnostics || []).find((d) => DIAGNOSTIC_REMEDIES[d.kind]?.routes);
  if (diag) return diagnosticRemedy(diag);
  return GRADE_SETS[mode]?.has(guessed[0]) ? null : modeFor(mode, guessed[0]);
}
