// jpa_naming.mjs — which naming spells a run's JPA names, and how sure that is: the profile's word, the project's configuration, a setting made in code, or a default that rests on how the project builds its EntityManagerFactory (RM67-J6).
//
// Spring Boot's naming (CamelCase to snake_case, and a join table named after
// the owning table and the attribute) is put into the factory Spring Boot
// builds. A project that builds its own gets something else:
//
//   none          Boot's factory, Boot's naming: assumed, HEURISTIC, as before.
//   builder-made  a @Bean built from Boot's EntityManagerFactoryBuilder: Boot's
//                 naming from Spring Boot 3.4 on, Hibernate's own before it.
//                 Boot's default stays the assumption and the reason says so.
//   hand-built    a `new`, an XML bean, a @Bean with no builder: Hibernate's own
//                 naming (PhysicalNamingStrategyStandardImpl keeps a name as
//                 written, ImplicitNamingStrategyJpaCompliantImpl names a join
//                 table after both tables), and Boot's properties do not reach it.
//
// Which kind a tree shows is read by the `jpa.entity-manager-factory` rules
// (src/core/rules/kinds/jpa_entity_manager_factory.mjs). The profile's
// jpa.namingStrategy states the physical strategy only and always wins; the
// implicit one follows the factory, or a setting made in code.

import { builtinRegistry } from '../core/rules/registry.mjs';

/** What each factory kind runs when nothing is declared: the physical strategy, the implicit one, and how the names say it. */
const DEFAULTS = Object.freeze({
  none: { physical: 'spring-snake-case', implicit: 'spring', evidence: 'assumed-spring-default' },
  'builder-made': { physical: 'spring-snake-case', implicit: 'spring', evidence: 'assumed-spring-default' },
  'hand-built': { physical: 'identity', implicit: 'jpa-compliant', evidence: 'assumed-hibernate-default' },
});

/** `file:line`, the way a reader goes and looks. */
export const siteSaid = (s) => `${s.file ?? '(unknown file)'}${s.line ? `:${s.line}` : ''}`;

/**
 * What the tree shows about its factories, merged over every rule of the kind:
 * the sites, the kind they make (hand-built wins, since Boot backs off for any
 * factory the project defines), and the naming settings made in code or XML.
 */
export function readFactoryKind(javaFacts, { rules = builtinRegistry().ofKind('jpa.entity-manager-factory'), xmlFactories = [] } = {}) {
  const reads = rules.map((r) => r.compiled(javaFacts, xmlFactories));
  const handBuilt = reads.flatMap((r) => r.handBuilt);
  const builderMade = reads.flatMap((r) => r.builderMade);
  const kind = handBuilt.length > 0 ? 'hand-built' : builderMade.length > 0 ? 'builder-made' : 'none';
  return { kind, handBuilt, builderMade, naming: reads.flatMap((r) => r.naming) };
}

/** The settings of one dimension made in code, and the one strategy they agree on (null when none names a modelled one, or they differ). */
function inCode(naming, dimension) {
  const sites = naming.filter((n) => n.dimension === dimension);
  const named = [...new Set(sites.map((n) => n.strategy))];
  return { sites, strategy: sites.length > 0 && named.length === 1 ? named[0] : null };
}

/**
 * How the project's configuration reaches the factory it builds: `declared`
 * (applied, EXACT), `assumed` (applied, HEURISTIC), `ignored`, or null when the
 * configuration names nothing that applies. `spring.jpa.hibernate.naming.*`
 * reaches Boot's own factory, and a builder-made one only from 3.4;
 * `spring.jpa.properties.hibernate.*` reaches both, always; neither reaches a
 * factory built by hand.
 */
function configReach(configured, kind) {
  if (!configured || !['configuration', 'unreadable'].includes(configured.from)) return null;
  if (kind === 'hand-built') return 'ignored';
  if (configured.from !== 'configuration') return null;
  if (kind === 'none' || (configured.vias ?? []).includes('passthrough')) return 'declared';
  return 'assumed';
}

/**
 * THE IMPLICIT STRATEGY THIS RUN IS SURE OF, and how sure: declared (the
 * profile's jpa.implicitNamingStrategy, or a configuration that reaches the
 * factory the same way `configReach` decides for the physical one), else a
 * setting made in code (never sure: a property can be set again elsewhere),
 * else the factory kind's default, not sure either (RM67-J7 — this is the gap
 * `jpa.namingStrategy` alone left open: it states the physical strategy only).
 */
function implicitPlan(declared, configured, factory, base) {
  const implicitInCode = inCode(factory.naming, 'implicit');
  const config = configReach(configured, factory.kind);
  if (declared != null) return { implicit: declared, implicitSure: true, implicitInCode, implicitConfig: config };
  if (implicitInCode.sites.length > 0) return { implicit: implicitInCode.strategy ?? base, implicitSure: false, implicitUnmodelled: implicitInCode.sites.some((s) => !s.strategy), implicitInCode, implicitConfig: config };
  if (config === 'declared') return { implicit: configured.strategy, implicitSure: true, implicitInCode, implicitConfig: config };
  if (config === 'assumed') return { implicit: configured.strategy, implicitSure: false, implicitInCode, implicitConfig: config };
  return { implicit: base, implicitSure: false, implicitUnmodelled: configured?.from === 'unreadable' && config !== 'ignored', implicitInCode, implicitConfig: config };
}

/**
 * THE NAMING A RUN SPELLS ITS JPA NAMES BY.
 * @param {{declared:(string|null), configured:(object|null), factory:object,
 *          declaredImplicit:(string|null), configuredImplicit:(object|null)}} a
 *   the profile's jpa.namingStrategy and jpa.implicitNamingStrategy, what
 *   `jpaNamingOf`/`jpaImplicitNamingOf` read from the configuration
 *   (src/core/lanes.mjs), and `readFactoryKind`'s answer
 * @returns {{strategy:string, declared:boolean, implicit:string, implicitSure:boolean, evidence:string,
 *            kind:string, config:(string|null), physicalInCode:object, implicitInCode:object, implicitConfig:(string|null)}}
 */
export function namingPlan({
  declared = null, configured = null, factory, declaredImplicit = null, configuredImplicit = null,
}) {
  const base = DEFAULTS[factory.kind];
  const physical = inCode(factory.naming, 'physical');
  const config = configReach(configured, factory.kind);
  const plan = { kind: factory.kind, config, physicalInCode: physical, ...implicitPlan(declaredImplicit, configuredImplicit, factory, base.implicit) };
  if (declared != null) return { ...plan, strategy: declared, declared: true, evidence: 'declared' };
  const fromConfig = config === 'declared' || config === 'assumed' ? configured.strategy : null;
  // A setting made in code is applied after the configuration, so it wins over it, and is never the project's declared word.
  if (physical.sites.length > 0) {
    return { ...plan, strategy: physical.strategy ?? fromConfig ?? base.physical, declared: false, evidence: 'assumed-set-in-code' };
  }
  if (config === 'declared') return { ...plan, strategy: fromConfig, declared: true, evidence: 'declared' };
  if (config === 'assumed') return { ...plan, strategy: fromConfig, declared: false, evidence: 'assumed-configuration' };
  return { ...plan, strategy: base.physical, declared: false, evidence: base.evidence };
}

/**
 * THE JPA BRIDGE'S NAMING, from its options: the plan it spells names by, and
 * the record its stats keep of it (the factories, what the configuration came
 * to, the clause the jpa axis says, the diagnostics, and the XML and service
 * files it was handed, which the working-tree overlay reads back).
 * @param {object[]} javaFacts
 * @param {{namingStrategy?:(string|null), configuredNaming?:(object|null), implicitNamingStrategy?:(string|null),
 *          configuredImplicitNaming?:(object|null), xmlFactories?:object[], serviceFiles?:object[], factoryRules?:object[]}} opts
 */
export function namingOf(javaFacts, opts = {}) {
  const factory = readFactoryKind(javaFacts, { rules: opts.factoryRules, xmlFactories: opts.xmlFactories ?? [] });
  const configured = opts.configuredNaming ?? null;
  const configuredImplicit = opts.configuredImplicitNaming ?? null;
  const plan = namingPlan({ declared: opts.namingStrategy ?? null, configured, factory, declaredImplicit: opts.implicitNamingStrategy ?? null, configuredImplicit });
  return {
    plan,
    naming: {
      kind: plan.kind, evidence: plan.evidence, implicit: plan.implicit, config: plan.config,
      handBuilt: factory.handBuilt, builderMade: factory.builderMade, inCode: factory.naming,
      derivedBy: derivedBySaid(plan, factory, configured),
      diagnostics: namingDiagnostics(plan, factory, configured, configuredImplicit),
      implicitNote: implicitNoteOf(plan),
      inputs: { xmlFactories: opts.xmlFactories ?? [], serviceFiles: opts.serviceFiles ?? [], resourcesRead: opts.resourcesRead !== false },
    },
  };
}

/** The first of some sites, and how many more there are. */
function sitesSaid(sites) {
  if (sites.length === 0) return null;
  return `${siteSaid(sites[0])}${sites.length > 1 ? ` and ${sites.length - 1} more` : ''}`;
}

/** What a naming setting made in code says: where, which key, and the strategy its value is when it names one this engine models. */
function inCodeSaid(s) {
  return `${siteSaid(s)} sets ${s.written ?? s.key} to ${s.className ?? 'a value this engine does not read'}${s.strategy ? `, which is the ${s.strategy} strategy` : ''}`;
}

/**
 * HOW A DERIVED NAME WAS SPELLED, as the clause the jpa axis and the notes
 * put after "we derived the name with". Spring Boot's default when nothing
 * else shows, in the words it always had.
 */
export function derivedBySaid(plan, factory, configured) {
  if (plan.evidence === 'assumed-set-in-code') return `the strategy set in code (${plan.physicalInCode.sites.map(inCodeSaid).join('; ')})`;
  if (plan.evidence === 'assumed-configuration') {
    return `the strategy the configuration names (${configured.classNames.join(', ')} in ${configured.files.join(', ')}), which reaches a factory built from Spring Boot's EntityManagerFactoryBuilder (${sitesSaid(factory.builderMade)}) only from Spring Boot 3.4`;
  }
  if (plan.kind === 'hand-built') {
    return `Hibernate's own default, which keeps a name as written, because the project builds its own EntityManagerFactory (${sitesSaid(factory.handBuilt)}) and Spring Boot's naming defaults do not reach a factory the project builds itself`;
  }
  if (plan.kind === 'builder-made') {
    return `Spring Boot's default (CamelCase to snake_case), which a factory built from Spring Boot's EntityManagerFactoryBuilder (${sitesSaid(factory.builderMade)}) gets from Spring Boot 3.4 on; before 3.4 such a factory gets Hibernate's own naming instead, which keeps a name as written`;
  }
  return 'Spring Boot\'s default (CamelCase to snake_case)';
}

/** What the configuration's naming came to when the factory decides it, or null when it came to what it always did. */
function configSaid(plan, configured) {
  if (plan.config === 'ignored') {
    return `the configuration names ${configured.classNames.join(', ')} in ${configured.files.join(', ')}, which does not reach a factory the project builds itself, so it is not applied`;
  }
  if (plan.evidence === 'assumed-configuration') {
    return 'the configuration names it under spring.jpa.hibernate.naming, which Spring Boot hands a builder-made factory only from 3.4, so it is applied and graded HEURISTIC';
  }
  return null;
}

/**
 * What a declared physical strategy leaves open when code sets the implicit
 * one: the join tables the mapping does not name. Null when nothing is open.
 */
function implicitNoteOf(plan) {
  if (plan.evidence !== 'declared' || plan.implicitSure || plan.implicitInCode.sites.length === 0) return null;
  return `${plan.implicitInCode.sites.map(inCodeSaid).join('; ')}. jpa.namingStrategy states the physical strategy only, so a join table the mapping does not name, where Spring Boot's and Hibernate's implicit strategies name it differently, is graded HEURISTIC; declare jpa.implicitNamingStrategy in the profile to settle it`;
}

/** What the implicit strategy rests on when nothing sets it in code: nothing at all, or a configuration that does not (fully) reach this factory. */
function implicitRestsOn(plan, configuredImplicit) {
  if (plan.implicitConfig === 'ignored') return `the configuration names one under spring.jpa.hibernate.naming.implicit-strategy or hibernate.implicit_naming_strategy, in ${configuredImplicit.files.join(', ')}, which does not reach a factory the project builds itself`;
  if (plan.implicitConfig === 'assumed') return 'the configuration names it under spring.jpa.hibernate.naming.implicit-strategy, which reaches a builder-made factory only from Spring Boot 3.4';
  if (configuredImplicit?.from === 'unreadable') return `the configuration in ${configuredImplicit.files.join(', ')} does not select a single supported implicit strategy unconditionally`;
  return 'nothing declares or configures it';
}

/**
 * THE GAP A DECLARED PHYSICAL STRATEGY LEAVES OPEN (RM67-J7): a default join
 * table's name also rests on the implicit strategy, and jpa.namingStrategy does
 * not state that one. Said once, under jpa.implicitNamingStrategy, when nothing
 * in code already explains it (`implicitNoteOf` does that).
 */
function implicitAssumedDiagnostic(plan, configuredImplicit) {
  if (plan.implicitUnmodelled) return {
    kind: 'JPA_IMPLICIT_NAMING_ASSUMED', severity: 'info', key: 'jpa.implicitNamingStrategy',
    reason: `The implicit naming strategy is unsupported or cannot be selected unconditionally. Default table, basic column, embedded column and join column names use the assumed ${plan.implicit} spelling and are graded HEURISTIC. Written names still follow the physical strategy. Verify the runtime strategy before declaring jpa.implicitNamingStrategy as a supported strategy`,
  };
  if (!plan.declared || plan.implicitSure || plan.implicitInCode.sites.length > 0) return null;
  const spelled = plan.implicit === 'jpa-compliant' ? 'the two tables' : 'the owning table and the attribute';
  return {
    kind: 'JPA_IMPLICIT_NAMING_ASSUMED', severity: 'info', key: 'jpa.implicitNamingStrategy',
    reason: `jpa.namingStrategy states the physical strategy only. A default join table's name also rests on the implicit strategy, which this run assumes names it after ${spelled}, because ${implicitRestsOn(plan, configuredImplicit)}. Where the other known implicit strategy would spell such a name differently, it stays HEURISTIC; declare jpa.implicitNamingStrategy in the profile to settle it`,
  };
}

/** The profile key a naming setting made in code is said under: implicit gets its own key now that one exists, physical still jpa.namingStrategy. */
const codeSettingKey = (s) => (s.dimension === 'implicit' ? 'jpa.implicitNamingStrategy' : 'jpa.namingStrategy');

/** One SETTING_IN_CODE diagnostic for a naming property or setter this run found in code or XML. */
function settingInCodeDiagnostic(s) {
  const key = codeSettingKey(s);
  return {
    kind: 'SETTING_IN_CODE', severity: 'warn', key,
    reason: `${inCodeSaid(s)}: the factory it reaches names tables and columns by that ${s.dimension} strategy. A property can be set again elsewhere, so names derived by it are graded HEURISTIC. This engine does not read a setting made in code, so declare it as \`${key}\` in the profile (rule jpa.entity-manager-factories)`,
  };
}

/**
 * WHAT THE RUN SAYS ABOUT ITS NAMING: the factory that decided the physical
 * assumption (JPA_NAMING_FROM_FACTORY), each naming property set in code or XML
 * (SETTING_IN_CODE; a setter call is said by the java.code-setting rule), and,
 * when the physical strategy is declared but the implicit one still rests on an
 * assumption, that gap on its own (JPA_IMPLICIT_NAMING_ASSUMED, RM67-J7).
 */
export function namingDiagnostics(plan, factory, configured, configuredImplicit) {
  if (plan.evidence === 'declared') {
    const d = implicitAssumedDiagnostic(plan, configuredImplicit);
    return d ? [d] : [];
  }
  const out = [];
  if (plan.kind !== 'none') {
    const config = configSaid(plan, configured);
    out.push({ kind: 'JPA_NAMING_FROM_FACTORY', severity: 'info', key: 'jpa.namingStrategy',
      reason: `names the mapping did not spell out, and names it writes that the strategies spell differently, are spelled by ${derivedBySaid(plan, factory, configured)}${config ? `; ${config}` : ''}. They are graded HEURISTIC; declare jpa.namingStrategy in the profile to settle it` });
  }
  for (const s of [...plan.physicalInCode.sites, ...plan.implicitInCode.sites]) out.push(settingInCodeDiagnostic(s));
  return out;
}
