// jpa_factory_naming.test.mjs — the naming a JPA name is spelled by rests on how the project builds its EntityManagerFactory (RM67-J6).
//
// Spring Boot gives its naming (CamelCase to snake_case, and a join table named
// after the owning table and the attribute) to the factory IT builds, and backs
// off when the project defines one. A factory built by hand runs Hibernate's own
// naming, which keeps a name as written: ngrinder builds its factory with `new`
// and its DDL has AGENT.hostName where the engine drew host_name. One built from
// Boot's EntityManagerFactoryBuilder gets Boot's naming from 3.4 on, which is
// why egov-msa-edu's DDL has created_by. Each case here is real Java through the
// real worker, then the Java and JPA bridges.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findJdk } from '../scripts/ci-java-smoke.mjs';
import { Graph } from '../src/core/graph.mjs';
import { addJavaFacts } from '../src/adapters/java_bridge.mjs';
import { addJpaFacts } from '../src/adapters/jpa_bridge.mjs';
import { builtinRegistry } from '../src/core/rules/registry.mjs';
import { xmlFactoriesIn } from '../src/core/rules/kinds/jpa_entity_manager_factory.mjs';
import { codeSettingDiagnostics } from '../src/core/code_settings.mjs';
import { discover } from '../src/core/discover.mjs';
import { DISCOVER_IO } from '../src/cli/env.mjs';
import { findJpaImplicitNamingStrategies } from '../src/core/springconfig.mjs';
import { jpaImplicitNamingOf } from '../src/core/lanes.mjs';
import {
  KEYS_DIGESTED_WHEN_SET, PROFILE_KEY_CONSUMERS, ProfileError, digestedProfile, normalizeProfile, validateProfile,
} from '../src/core/profile.mjs';

const ENGINE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const SKIP = 'no JDK found: JAVA_HOME is unset and no javac on PATH, see docs/setup/java-lane.md';
const J = 'package p; import javax.persistence.*; import java.util.*;';
const LCEMFB = 'org.springframework.orm.jpa.LocalContainerEntityManagerFactoryBean';

let built = null;
/** The worker, compiled once for this file; null without a JDK. */
function worker() {
  const jdk = findJdk();
  if (!jdk) return null;
  if (built === null) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-jpa-j6-cls-'));
    execFileSync(jdk.javac, ['-d', dir, path.join(ENGINE_ROOT, 'adapters', 'java', 'JavaFacts.java')], { stdio: ['ignore', 'ignore', 'inherit'] });
    built = { jdk, dir };
  }
  return built;
}

/** A tree of files under a fresh directory, removed after the test. */
function tree(t, files, prefix = 'cascade-jpa-j6-') {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, src] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), src);
  }
  return root;
}

/** The worker's records for `sources`, or null without a JDK. */
function factsOf(t, sources) {
  const w = worker();
  if (!w) return null;
  const root = tree(t, sources);
  return execFileSync(w.jdk.java, ['-cp', w.dir, 'JavaFacts', '--root', root, root], { maxBuffer: 1 << 26 })
    .toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** Both bridges over `sources`: the column ids and grades, the join tables, and the JPA stats. */
function jpaRun(t, sources, opts = {}) {
  const records = factsOf(t, sources);
  if (!records) return null;
  const g = new Graph();
  addJavaFacts(g, records, {});
  const stats = addJpaFacts(g, records, { identifierCase: 'exact', ...opts });
  const declares = new Map(g.edges.filter((e) => e.type === 'DECLARES').map((e) => [e.to, e.grade]));
  const column = (id) => (g.nodes.has(`column:${id}`) ? declares.get(`column:${id}`) ?? 'catalog' : null);
  const tables = [...g.nodes.keys()].filter((id) => id.startsWith('table:')).map((id) => id.slice('table:'.length)).sort();
  return { g, stats, column, tables, records };
}
const notes = (r) => r.stats.unresolved.map((u) => `${u.reason}: ${u.detail ?? ''}`);
const diagnosticsOf = (r) => r.stats.naming.diagnostics.map((d) => `${d.kind} ${d.reason}`);

/** ngrinder's AgentInfo as its source maps it: an explicit camelCase column, a derived one, and the key. */
const AGENT = `${J} @Entity @Table(name = "AGENT") public class AgentInfo { @Id Long id; @Column(name = "hostName") String hostName; Integer agentPort; String ip; }`;

/** ngrinder's DatabaseConfig: a @Bean that builds the factory with `new`. */
const NEW_FACTORY = `package p;
import org.springframework.context.annotation.Bean;
import ${LCEMFB};
public class DatabaseConfig {
    @Bean(name = "emf")
    public LocalContainerEntityManagerFactoryBean emf() {
        LocalContainerEntityManagerFactoryBean emf = new LocalContainerEntityManagerFactoryBean();
        emf.setPersistenceUnitName("ngrinder");
        return emf;
    }
}
`;

// ---------------------------------------------------------------------------
// a factory the project builds by hand
// ---------------------------------------------------------------------------

test('a factory built with new keeps a written camelCase name as written, HEURISTIC, and says where the factory is', (t) => {
  const r = jpaRun(t, { 'p/AgentInfo.java': AGENT, 'p/DatabaseConfig.java': NEW_FACTORY });
  if (!r) { t.skip(SKIP); return; }
  assert.equal(r.column('AGENT.hostName'), 'HEURISTIC', 'the DDL says hostName, and nothing declares the strategy');
  assert.equal(r.stats.naming.kind, 'hand-built');
  assert.equal(r.stats.namingStrategy, 'identity');
  assert.equal(r.column('AGENT.host_name'), null, 'Spring Boot\'s spelling is not drawn');
  assert.equal(r.column('AGENT.agentPort'), 'HEURISTIC', 'a derived name is kept as written too');
  assert.equal(r.column('agent.host_name'), null, 'nor is its table in Spring Boot\'s spelling');
  const said = diagnosticsOf(r).find((d) => d.startsWith('JPA_NAMING_FROM_FACTORY'));
  assert.match(said, /p\/DatabaseConfig\.java:7/);
  assert.match(said, /Spring Boot's naming defaults do not reach a factory the project builds itself/);
  assert.ok(notes(r).some((n) => /written-name-assumed/.test(n) && /hostName as hostName/.test(n) && /DatabaseConfig\.java:7/.test(n)), notes(r).join('\n'));
});

test('a @Bean that returns an EntityManagerFactory and takes no builder is built by hand', (t) => {
  const r = jpaRun(t, {
    'p/AgentInfo.java': AGENT,
    'p/UnitConfig.java': `package p;
import jakarta.persistence.EntityManagerFactory;
import jakarta.persistence.Persistence;
import org.springframework.context.annotation.Bean;
public class UnitConfig {
    @Bean
    public EntityManagerFactory entityManagerFactory() { return Persistence.createEntityManagerFactory("unit"); }
}
`,
  });
  if (!r) { t.skip(SKIP); return; }
  assert.equal(r.column('AGENT.hostName'), 'HEURISTIC');
  assert.equal(r.stats.naming.kind, 'hand-built');
  assert.deepEqual(r.stats.naming.handBuilt.map((s) => `${s.how} ${s.method}:${s.line}`), ['bean p.UnitConfig#entityManagerFactory:6']);
});

test('a factory declared as a Spring XML bean is built by hand, read from the XML discovery hands the bridge', (t) => {
  const [rule] = builtinRegistry().ofKind('jpa.entity-manager-factory');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<beans xmlns="http://www.springframework.org/schema/beans">
  <bean id="entityManagerFactory" class="${LCEMFB}">
    <property name="dataSource" ref="dataSource"/>
  </bean>
</beans>
`;
  const xmlFactories = xmlFactoriesIn([{ path: 'src/main/resources/egovframework/spring/context-jpa.xml', text: xml }], rule.rule);
  const r = jpaRun(t, { 'p/AgentInfo.java': AGENT }, { xmlFactories });
  if (!r) { t.skip(SKIP); return; }
  assert.equal(r.column('AGENT.hostName'), 'HEURISTIC');
  assert.equal(r.stats.naming.kind, 'hand-built');
  assert.match(diagnosticsOf(r).join('\n'), /context-jpa\.xml:3/);
  // …and without the XML, the same entity is Spring Boot's, table and column.
  const boot = jpaRun(t, { 'p/AgentInfo.java': AGENT });
  assert.equal(boot.stats.naming.kind, 'none');
  assert.equal(boot.column('agent.host_name'), 'HEURISTIC');
});

test('a hand-built factory names a default join table after both tables, as Hibernate\'s own implicit strategy does', (t) => {
  const owner = `${J} @Entity @Table(name = "owners") public class Owner { @Id Long id; @ManyToMany Set<Tag> specialTags; }`;
  const tag = `${J} @Entity @Table(name = "tags") public class Tag { @Id Long id; }`;
  const hand = jpaRun(t, { 'p/Owner.java': owner, 'p/Tag.java': tag, 'p/DatabaseConfig.java': NEW_FACTORY });
  if (!hand) { t.skip(SKIP); return; }
  assert.ok(hand.tables.includes('owners_tags'), hand.tables.join(' '));
  assert.equal(hand.stats.naming.implicit, 'jpa-compliant');
  assert.ok(!hand.tables.includes('owners_specialTags') && !hand.tables.includes('owners_special_tags'), hand.tables.join(' '));
  // Spring Boot's own factory keeps SpringImplicitNamingStrategy: the owning table and the attribute.
  const boot = jpaRun(t, { 'p/Owner.java': owner, 'p/Tag.java': tag });
  assert.equal(boot.stats.naming.implicit, 'spring');
  assert.ok(boot.tables.includes('owners_special_tags'), boot.tables.join(' '));
});

test('an implicit strategy set in code names the join table, and a declared physical strategy does not make that name sure', (t) => {
  const owner = `${J} @Entity @Table(name = "owners") public class Owner { @Id Long id; @ManyToMany Set<Tag> specialTags; }`;
  const tag = `${J} @Entity @Table(name = "tags") public class Tag { @Id Long id; }`;
  const naming = `package p;
import java.util.Map;
import org.hibernate.boot.model.naming.ImplicitNamingStrategyJpaCompliantImpl;
import org.hibernate.cfg.AvailableSettings;
import org.springframework.boot.autoconfigure.orm.jpa.HibernatePropertiesCustomizer;
import org.springframework.context.annotation.Bean;
public class NamingConfig {
    @Bean
    HibernatePropertiesCustomizer naming() {
        return (Map<String, Object> props) -> props.put(AvailableSettings.IMPLICIT_NAMING_STRATEGY, ImplicitNamingStrategyJpaCompliantImpl.class.getName());
    }
}
`;
  const r = jpaRun(t, { 'p/Owner.java': owner, 'p/Tag.java': tag, 'p/NamingConfig.java': naming }, { namingStrategy: 'spring-snake-case' });
  if (!r) { t.skip(SKIP); return; }
  assert.ok(r.tables.includes('owners_tags'), r.tables.join(' '));
  assert.equal(r.column('owners_tags.owner_id'), 'HEURISTIC', 'the join table\'s name rests on a setting code can change');
  assert.equal(r.column('owners.id'), 'EXACT', 'the physical strategy is declared');
  assert.ok(notes(r).some((n) => /implicit-naming-set-in-code/.test(n) && /p\/NamingConfig\.java:10/.test(n)), notes(r).join('\n'));
  // The profile settles the implicit strategy even when a code setting was read.
  for (const [implicitNamingStrategy, table] of [['spring', 'owners_special_tags'], ['jpa-compliant', 'owners_tags']]) {
    const settled = jpaRun(t, { 'p/Owner.java': owner, 'p/Tag.java': tag, 'p/NamingConfig.java': naming },
      { namingStrategy: 'spring-snake-case', implicitNamingStrategy });
    assert.equal(settled.stats.naming.implicit, implicitNamingStrategy);
    assert.equal(settled.column(`${table}.owner_id`), 'EXACT');
    assert.equal(settled.column(`${table}.special_tags_id`), 'EXACT');
    assert.deepEqual(settled.g.edges.filter((e) => e.type === 'JOINS').map((e) => e.grade), ['EXACT', 'EXACT']);
    assert.equal(settled.stats.naming.implicitNote, null, 'a declared implicit strategy leaves no uncertainty note');
    assert.ok(!notes(settled).some((n) => /implicit-naming-set-in-code/.test(n)), notes(settled).join('\n'));
    assert.deepEqual(settled.stats.naming.diagnostics, []);
  }
});

test('a declared physical strategy alone leaves a default join table\'s name resting on the assumed implicit one, said and fixed by jpa.implicitNamingStrategy (RM67-J7)', (t) => {
  const owner = `${J} @Entity @Table(name = "owners") public class Owner { @Id Long id; @ManyToMany Set<Tag> specialTags; }`;
  const tag = `${J} @Entity @Table(name = "tags") public class Tag { @Id Long id; }`;
  // A hand-built factory: the implicit default is jpa-compliant (the two tables), not sure until declared.
  const hand = jpaRun(t, { 'p/Owner.java': owner, 'p/Tag.java': tag, 'p/DatabaseConfig.java': NEW_FACTORY }, { namingStrategy: 'spring-snake-case' });
  if (!hand) { t.skip(SKIP); return; }
  assert.ok(hand.tables.includes('owners_tags'), hand.tables.join(' '));
  assert.equal(hand.column('owners_tags.owner_id'), 'HEURISTIC', 'the physical strategy is declared, but the implicit one is only assumed');
  const said = diagnosticsOf(hand).find((d) => d.startsWith('JPA_IMPLICIT_NAMING_ASSUMED'));
  assert.match(said, /jpa\.namingStrategy states the physical strategy only/);
  assert.match(said, /the two tables/);
  assert.match(said, /nothing declares or configures it/);
  assert.equal(hand.stats.naming.diagnostics.find((d) => d.kind === 'JPA_IMPLICIT_NAMING_ASSUMED').key, 'jpa.implicitNamingStrategy');
  // Declared, the join table is EXACT and the gap is gone.
  const settled = jpaRun(t, { 'p/Owner.java': owner, 'p/Tag.java': tag, 'p/DatabaseConfig.java': NEW_FACTORY },
    { namingStrategy: 'spring-snake-case', implicitNamingStrategy: 'jpa-compliant' });
  assert.equal(settled.column('owners_tags.owner_id'), 'EXACT');
  assert.deepEqual(settled.stats.naming.diagnostics, []);
});

// ---------------------------------------------------------------------------
// a naming strategy set in code
// ---------------------------------------------------------------------------

/** shopizer's DataConfiguration, with a naming key among the properties its helper puts. */
const withNamingProperty = (value) => `package p;
import java.util.Properties;
import org.springframework.context.annotation.Bean;
import ${LCEMFB};
public class DataConfiguration {
    @Bean
    public LocalContainerEntityManagerFactoryBean entityManagerFactory() {
        LocalContainerEntityManagerFactoryBean factory = new LocalContainerEntityManagerFactoryBean();
        factory.setJpaProperties(additionalProperties());
        return factory;
    }
    final Properties additionalProperties() {
        final Properties hibernateProperties = new Properties();
        hibernateProperties.setProperty("hibernate.dialect", "x");
        hibernateProperties.setProperty("hibernate.physical_naming_strategy", ${value});
        return hibernateProperties;
    }
}
`;

test('a naming property set in code with a class Hibernate ships is that strategy, still HEURISTIC, and said', (t) => {
  const r = jpaRun(t, {
    'p/AgentInfo.java': AGENT,
    'p/DataConfiguration.java': withNamingProperty('org.hibernate.boot.model.naming.CamelCaseToUnderscoresNamingStrategy.class.getName()'),
  });
  if (!r) { t.skip(SKIP); return; }
  assert.equal(r.column('agent.host_name'), 'HEURISTIC', 'a property may be set again elsewhere');
  const said = (r.stats.naming?.diagnostics ?? []).map((d) => `${d.kind} ${d.reason}`).find((d) => d.startsWith('SETTING_IN_CODE'));
  assert.ok(said, 'the setting is said');
  assert.equal(r.stats.naming.kind, 'hand-built');
  assert.equal(r.stats.naming.evidence, 'assumed-set-in-code');
  assert.equal(r.stats.namingStrategy, 'spring-snake-case');
  assert.match(said, /p\/DataConfiguration\.java:15 sets hibernate\.physical_naming_strategy to org\.hibernate\.boot\.model\.naming\.CamelCaseToUnderscoresNamingStrategy, which is the spring-snake-case strategy/);
  assert.equal(r.stats.naming.diagnostics.find((d) => d.kind === 'SETTING_IN_CODE').key, 'jpa.namingStrategy');
});

test('a naming property whose class this engine does not model is said, and the factory\'s default stays the assumption', (t) => {
  const r = jpaRun(t, { 'p/AgentInfo.java': AGENT, 'p/DataConfiguration.java': withNamingProperty('"com.acme.OwnNamingStrategy"') });
  if (!r) { t.skip(SKIP); return; }
  assert.equal(r.stats.namingStrategy, 'identity', 'Hibernate\'s own, as the hand-built factory would run');
  assert.equal(r.column('AGENT.hostName'), 'HEURISTIC');
  assert.match(diagnosticsOf(r).join('\n'), /SETTING_IN_CODE p\/DataConfiguration\.java:15 sets hibernate\.physical_naming_strategy to com\.acme\.OwnNamingStrategy:/);
  // Declared, the profile's word is taken and nothing more is said about the PHYSICAL
  // strategy; the implicit one is still undeclared (RM67-J7), so that gap is said on its own.
  const declared = jpaRun(t, { 'p/AgentInfo.java': AGENT, 'p/DataConfiguration.java': withNamingProperty('"com.acme.OwnNamingStrategy"') }, { namingStrategy: 'identity' });
  assert.deepEqual(declared.stats.naming.diagnostics.map((d) => d.kind), ['JPA_IMPLICIT_NAMING_ASSUMED']);
  assert.equal(declared.column('AGENT.hostName'), 'EXACT');
  // Declaring both leaves nothing to say.
  const both = jpaRun(t, { 'p/AgentInfo.java': AGENT, 'p/DataConfiguration.java': withNamingProperty('"com.acme.OwnNamingStrategy"') },
    { namingStrategy: 'identity', implicitNamingStrategy: 'jpa-compliant' });
  assert.deepEqual(both.stats.naming.diagnostics, []);
});

test('a naming strategy handed to a setter is a setting made in code, said under jpa.namingStrategy while it is undeclared', (t) => {
  const records = factsOf(t, {
    'p/SessionConfig.java': `package p;
import org.hibernate.boot.model.naming.PhysicalNamingStrategyStandardImpl;
import org.springframework.orm.hibernate5.LocalSessionFactoryBean;
public class SessionConfig {
    public LocalSessionFactoryBean sessionFactory() {
        LocalSessionFactoryBean factory = new LocalSessionFactoryBean();
        factory.setPhysicalNamingStrategy(new PhysicalNamingStrategyStandardImpl());
        return factory;
    }
}
`,
  });
  if (!records) { t.skip(SKIP); return; }
  const said = codeSettingDiagnostics(records, { jpa: { namingStrategy: null } }).filter((d) => d.key === 'jpa.namingStrategy');
  assert.equal(said.length, 1);
  assert.match(said[0].reason, /p\/SessionConfig\.java:7 calls LocalSessionFactoryBean\.setPhysicalNamingStrategy/);
  assert.match(said[0].reason, /rule jpa\.naming-set-in-code/);
  assert.deepEqual(codeSettingDiagnostics(records, { jpa: { namingStrategy: 'identity' } }).filter((d) => d.key === 'jpa.namingStrategy'), []);
});

// ---------------------------------------------------------------------------
// Spring Boot's own factory, and one built from Boot's builder
// ---------------------------------------------------------------------------

/** egov-msa-edu's board service: the factory is built from the builder Spring Boot hands out. */
const BUILDER_FACTORY = `package p;
import javax.sql.DataSource;
import org.springframework.boot.orm.jpa.EntityManagerFactoryBuilder;
import org.springframework.context.annotation.Bean;
import ${LCEMFB};
public class BoardServiceJpaConfig {
    @Bean(name = "entityManagerFactory")
    LocalContainerEntityManagerFactoryBean entityManagerFactory(EntityManagerFactoryBuilder builder, DataSource dataSource) {
        return builder.dataSource(dataSource).packages("p").persistenceUnit("default").build();
    }
}
`;
const COMMENT = `${J} @Entity public class Comment { @Id Long id; @Column(name = "createdBy") String creator; String commentContent; }`;

test('a Spring Boot project that defines no factory is as it was: Spring Boot\'s naming assumed, nothing more said', (t) => {
  const r = jpaRun(t, { 'p/Comment.java': COMMENT });
  if (!r) { t.skip(SKIP); return; }
  assert.equal(r.stats.naming.kind, 'none');
  assert.equal(r.stats.naming.evidence, 'assumed-spring-default');
  assert.equal(r.column('comment.created_by'), 'HEURISTIC');
  assert.equal(r.column('comment.comment_content'), 'HEURISTIC');
  assert.deepEqual(r.stats.naming.diagnostics, []);
  assert.ok(notes(r).some((n) => /written-name-assumed/.test(n) && /assumed default naming's spelling, graded HEURISTIC$/.test(n)), notes(r).join('\n'));
});

test('a factory built from Spring Boot\'s builder keeps Spring Boot\'s naming assumed, and says it holds from 3.4 on', (t) => {
  const r = jpaRun(t, { 'p/Comment.java': COMMENT, 'p/BoardServiceJpaConfig.java': BUILDER_FACTORY });
  if (!r) { t.skip(SKIP); return; }
  assert.equal(r.stats.naming.kind, 'builder-made');
  assert.equal(r.stats.namingStrategy, 'spring-snake-case');
  assert.equal(r.column('comment.created_by'), 'HEURISTIC', 'egov-msa-edu\'s DDL has created_by');
  assert.equal(r.column('comment.createdBy'), null);
  const said = diagnosticsOf(r).find((d) => d.startsWith('JPA_NAMING_FROM_FACTORY'));
  assert.match(said, /p\/BoardServiceJpaConfig\.java:7/);
  assert.match(said, /before 3\.4 such a factory gets Hibernate's own naming instead/);
});

test('the configuration\'s naming reaches a builder-made factory by spring.jpa.properties always, and by Boot\'s own key only from 3.4', (t) => {
  const configured = (via) => ({
    strategy: 'identity', from: 'configuration', files: ['src/main/resources/application.yml'],
    classNames: ['org.hibernate.boot.model.naming.PhysicalNamingStrategyStandardImpl'], vias: [via],
  });
  const boot = jpaRun(t, { 'p/Comment.java': COMMENT, 'p/BoardServiceJpaConfig.java': BUILDER_FACTORY }, { configuredNaming: configured('boot') });
  if (!boot) { t.skip(SKIP); return; }
  assert.equal(boot.column('Comment.createdBy'), 'HEURISTIC', 'applied, and graded as a guess');
  assert.equal(boot.stats.naming.config, 'assumed');
  assert.equal(boot.stats.namingStrategy, 'identity');
  assert.match(diagnosticsOf(boot).join('\n'), /only from Spring Boot 3\.4/);
  const passthrough = jpaRun(t, { 'p/Comment.java': COMMENT, 'p/BoardServiceJpaConfig.java': BUILDER_FACTORY }, { configuredNaming: configured('passthrough') });
  assert.equal(passthrough.stats.naming.config, 'declared');
  assert.equal(passthrough.stats.namingStrategyDeclared, true);
  assert.equal(passthrough.column('Comment.createdBy'), 'EXACT');
  // Spring Boot's own factory takes either key, as it always did.
  const none = jpaRun(t, { 'p/Comment.java': COMMENT }, { configuredNaming: configured('boot') });
  assert.equal(none.stats.naming.config, 'declared');
  assert.equal(none.column('Comment.createdBy'), 'EXACT');
});

test('the configuration\'s IMPLICIT naming reaches a builder-made factory by spring.jpa.properties always, and by Boot\'s own key only from 3.4 (RM67-J7)', (t) => {
  const owner = `${J} @Entity @Table(name = "owners") public class Owner { @Id Long id; @ManyToMany Set<Tag> specialTags; }`;
  const tag = `${J} @Entity @Table(name = "tags") public class Tag { @Id Long id; }`;
  const configuredImplicit = (via) => ({
    strategy: 'jpa-compliant', from: 'configuration', files: ['src/main/resources/application.yml'],
    classNames: ['org.hibernate.boot.model.naming.ImplicitNamingStrategyJpaCompliantImpl'], vias: [via],
  });
  const boot = jpaRun(t, { 'p/Owner.java': owner, 'p/Tag.java': tag, 'p/BoardServiceJpaConfig.java': BUILDER_FACTORY },
    { namingStrategy: 'spring-snake-case', configuredImplicitNaming: configuredImplicit('boot') });
  if (!boot) { t.skip(SKIP); return; }
  assert.ok(boot.tables.includes('owners_tags'), boot.tables.join(' '));
  assert.equal(boot.column('owners_tags.owner_id'), 'HEURISTIC', 'applied, but only from Spring Boot 3.4, so still a guess');
  assert.match(diagnosticsOf(boot).find((d) => d.startsWith('JPA_IMPLICIT_NAMING_ASSUMED')), /only from Spring Boot 3\.4/);
  const passthrough = jpaRun(t, { 'p/Owner.java': owner, 'p/Tag.java': tag, 'p/BoardServiceJpaConfig.java': BUILDER_FACTORY },
    { namingStrategy: 'spring-snake-case', configuredImplicitNaming: configuredImplicit('passthrough') });
  assert.equal(passthrough.column('owners_tags.owner_id'), 'EXACT');
  assert.deepEqual(passthrough.stats.naming.diagnostics, []);
  for (const via of ['boot', 'passthrough']) {
    const configuredImplicitNaming = configuredImplicit(via);
    const none = jpaRun(t, { 'p/Owner.java': owner, 'p/Tag.java': tag },
      { namingStrategy: 'spring-snake-case', configuredImplicitNaming });
    assert.equal(none.column('owners_tags.owner_id'), 'EXACT', `${via} reaches Boot's own factory`);
    assert.deepEqual(none.stats.naming.diagnostics, []);
    const hand = jpaRun(t, { 'p/Owner.java': owner, 'p/Tag.java': tag, 'p/DatabaseConfig.java': NEW_FACTORY },
      { namingStrategy: 'spring-snake-case', configuredImplicitNaming: { ...configuredImplicitNaming, strategy: 'spring' } });
    assert.equal(hand.column('owners_tags.owner_id'), 'HEURISTIC', `${via} does not reach a hand-built factory`);
    assert.match(diagnosticsOf(hand).join('\n'), /does not reach a factory the project builds itself/);
  }
});

test('unsupported implicit strategies remain visible and cannot declare a default join table EXACT', (t) => {
  const sources = {
    'p/Owner.java': `${J} @Entity @Table(name = "owners") public class Owner { @Id Long id; @ManyToMany Set<Tag> specialTags; }`,
    'p/Tag.java': `${J} @Entity @Table(name = "tags") public class Tag { @Id Long id; }`,
  };
  for (const strategy of ['LegacyJpa', 'LegacyHbm', 'ComponentPath']) {
    const diagnostics = [];
    const found = findJpaImplicitNamingStrategies([{ path: 'application.properties',
      text: `spring.jpa.hibernate.naming.implicit-strategy=org.hibernate.boot.model.naming.ImplicitNamingStrategy${strategy}Impl\n` }], diagnostics);
    const configuredImplicitNaming = jpaImplicitNamingOf({}, found);
    assert.equal(configuredImplicitNaming.from, 'unreadable');
    assert.match(diagnostics[0].reason, /does not model.*HEURISTIC.*jpa\.implicitNamingStrategy/);
    const r = jpaRun(t, sources, { namingStrategy: 'spring-snake-case', configuredImplicitNaming });
    if (!r) { t.skip(SKIP); return; }
    assert.equal(r.column('owners_special_tags.owner_id'), 'HEURISTIC');
    assert.match(diagnosticsOf(r).join('\n'), /unsupported or cannot be selected unconditionally.*Default table, basic column, embedded column and join column names.*HEURISTIC/);
  }
});

test('an unsupported implicit strategy caps derived names but preserves explicit names, unless ignored or overridden', (t) => {
  const sources = {
    'p/Owner.java': `${J} @Entity @Table(name = "owners") public class Owner { @Id @Column(name="id") Long id;
      @Embedded Addr address; @ManyToOne Target target; @ManyToOne @JoinColumn(name="written_target") Target namedTarget;
      String basic; @Column(name="written_name") String written;
      @ManyToMany Set<Target> targets; }`,
    'p/Addr.java': `${J} @Embeddable public class Addr { String city; @Column(name="written_zip") String zip; }`,
    'p/Target.java': `${J} @Entity @Table(name="targets") public class Target { @Id @Column(name="id") Long id; }`,
    'p/DefaultTable.java': `${J} @Entity public class DefaultTable { @Id @Column(name="id") Long id; }`,
  };
  for (const strategy of ['ComponentPath', 'LegacyHbm']) {
    const className = `org.hibernate.boot.model.naming.ImplicitNamingStrategy${strategy}Impl`;
    const configuredImplicitNaming = jpaImplicitNamingOf({}, findJpaImplicitNamingStrategies([
      { path: 'application.properties', text: `spring.jpa.hibernate.naming.implicit-strategy=${className}\n` },
    ]));
    const configured = { namingStrategy: 'identity', configuredImplicitNaming };
    const code = { ...sources, 'p/NamingConfig.java': `package p;
      import org.springframework.context.annotation.Bean;
      import org.springframework.boot.autoconfigure.orm.jpa.HibernatePropertiesCustomizer;
      public class NamingConfig { @Bean HibernatePropertiesCustomizer naming() {
        return props -> props.put("hibernate.implicit_naming_strategy", "${className}");
      } }` };
    for (const [files, opts] of [[sources, configured], [code, { namingStrategy: 'identity' }]]) {
      const r = jpaRun(t, files, opts);
      if (!r) { t.skip(SKIP); return; }
      for (const col of ['owners.city', 'owners.basic', 'owners.target_id', 'DefaultTable.id', 'owners_targets.Owner_id']) {
        assert.equal(r.column(col), 'HEURISTIC', `${strategy} can alter ${col}`);
      }
      for (const col of ['owners.id', 'owners.written_name', 'owners.written_zip', 'owners.written_target']) {
        assert.equal(r.column(col), 'EXACT', `${strategy} does not alter explicit ${col}`);
      }
      assert.match(diagnosticsOf(r).join('\n'), /implicit naming strategy is unsupported.*HEURISTIC/);
      const settled = jpaRun(t, files, { ...opts, implicitNamingStrategy: 'jpa-compliant' });
      for (const col of ['owners.city', 'owners.basic', 'owners.target_id', 'DefaultTable.id']) assert.equal(settled.column(col), 'EXACT');
      assert.deepEqual(settled.stats.naming.diagnostics, []);
    }
    const ignored = jpaRun(t, { ...sources, 'p/DatabaseConfig.java': NEW_FACTORY }, configured);
    assert.equal(ignored.column('owners.city'), 'EXACT', 'Boot configuration does not reach a hand-built factory');
    assert.equal(ignored.column('owners.target_id'), 'EXACT');
    assert.match(diagnosticsOf(ignored).join('\n'), /does not reach a factory the project builds itself/);
  }
});

test('the configuration\'s naming does not reach a factory built by hand, and the run says it was not applied', (t) => {
  const r = jpaRun(t, { 'p/AgentInfo.java': AGENT, 'p/DatabaseConfig.java': NEW_FACTORY }, {
    configuredNaming: {
      strategy: 'spring-snake-case', from: 'configuration', files: ['src/main/resources/application.yml'],
      classNames: ['org.hibernate.boot.model.naming.CamelCaseToUnderscoresNamingStrategy'], vias: ['boot', 'passthrough'],
    },
  });
  if (!r) { t.skip(SKIP); return; }
  assert.equal(r.column('AGENT.hostName'), 'HEURISTIC');
  assert.equal(r.stats.namingStrategyDeclared, false);
  assert.equal(r.stats.naming.config, 'ignored');
  assert.match(diagnosticsOf(r).join('\n'), /application\.yml, which does not reach a factory the project builds itself, so it is not applied/);
});

// ---------------------------------------------------------------------------
// a Hibernate extension registered for ServiceLoader
// ---------------------------------------------------------------------------

test('an Integrator registered in META-INF/services leaves no project annotation inert', (t) => {
  const sources = {
    'p/Cloneable.java': 'package p; import java.lang.annotation.*; @Target(ElementType.FIELD) @Retention(RetentionPolicy.RUNTIME) @Documented public @interface Cloneable {}',
    'p/PerfTest.java': `${J} @Entity @Table(name = "perf_test") public class PerfTest { @Id Long id; @Cloneable @Column(name = "test_name") String testName; }`,
  };
  const free = jpaRun(t, sources, { namingStrategy: 'spring-snake-case' });
  if (!free) { t.skip(SKIP); return; }
  assert.equal(free.column('perf_test.test_name'), 'EXACT', 'no extension point: the marker is inert');
  const serviceFiles = [{ path: 'ngrinder-core/src/main/resources/META-INF/services/org.hibernate.integrator.spi.Integrator', service: 'org.hibernate.integrator.spi.Integrator' }];
  const blocked = jpaRun(t, sources, { namingStrategy: 'spring-snake-case', serviceFiles });
  assert.equal(blocked.column('perf_test.test_name'), 'HEURISTIC');
  assert.ok(notes(blocked).some((n) => /inert-annotations-blocked/.test(n) && /META-INF\/services\/org\.hibernate\.integrator\.spi\.Integrator registers/.test(n)), notes(blocked).join('\n'));
  // A service file for an interface the rule does not list changes nothing.
  const other = jpaRun(t, sources, { namingStrategy: 'spring-snake-case', serviceFiles: [{ path: 'x/META-INF/services/java.sql.Driver', service: 'java.sql.Driver' }] });
  assert.equal(other.column('perf_test.test_name'), 'EXACT');
});

test('discovery finds the factory beans a Spring XML declares and the META-INF/services files, tests left out', (t) => {
  const root = tree(t, {
    'src/main/resources/egovframework/spring/context-jpa.xml': `<beans xmlns="http://www.springframework.org/schema/beans">
  <bean id="entityManagerFactory" class="${LCEMFB}">
    <property name="jpaPropertyMap">
      <map><entry key="hibernate.physical_naming_strategy" value="org.hibernate.boot.model.naming.PhysicalNamingStrategyStandardImpl"/></map>
    </property>
  </bean>
  <bean id="other" class="org.example.Plain"/>
</beans>
`,
    'src/main/resources/META-INF/services/org.hibernate.integrator.spi.Integrator': 'org.example.AuditIntegrator\n',
    'src/test/resources/META-INF/services/org.hibernate.integrator.spi.Integrator': 'org.example.TestIntegrator\n',
  });
  const d = discover(root, DISCOVER_IO);
  assert.deepEqual(d.jpaFactories.map((f) => `${f.className} ${f.file}:${f.line}`), [`${LCEMFB} src/main/resources/egovframework/spring/context-jpa.xml:2`]);
  assert.deepEqual(d.jpaFactories[0].keys.map((k) => `${k.via} ${k.key}=${k.value}:${k.line}`),
    ['entry hibernate.physical_naming_strategy=org.hibernate.boot.model.naming.PhysicalNamingStrategyStandardImpl:4']);
  assert.deepEqual(d.serviceFiles, [{ path: 'src/main/resources/META-INF/services/org.hibernate.integrator.spi.Integrator', service: 'org.hibernate.integrator.spi.Integrator' }]);
});

// ---------------------------------------------------------------------------
// init and analyze, end to end: the yml key beside a factory built by hand
// ---------------------------------------------------------------------------

test('init writes no naming for the yml key, and analyze does not apply it to a factory the project builds itself', (t) => {
  if (!worker()) { t.skip(SKIP); return; }
  const root = tree(t, {
    'pom.xml': '<project/>',
    'src/main/java/p/AgentInfo.java': AGENT,
    'src/main/java/p/DatabaseConfig.java': NEW_FACTORY,
    // A route, so discovery gives the Java lane something to serve.
    'src/main/java/p/AgentController.java': 'package p; import org.springframework.web.bind.annotation.*; @RestController public class AgentController { @GetMapping("/agents") public String list() { return "a"; } }',
    'src/main/resources/application.yml': 'spring:\n  jpa:\n    hibernate:\n      naming:\n        physical-strategy: org.hibernate.boot.model.naming.CamelCaseToUnderscoresNamingStrategy\n',
  }, 'cascade-jpa-j6-e2e-');
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.email=dev@example.com', '-c', 'user.name=dev', 'commit', '-qm', 'init');
  const home = tree(t, {}, 'cascade-jpa-j6-home-');
  const env = { ...process.env, CASCADE_HOME: path.join(home, 'home'), XDG_CACHE_HOME: path.join(home, 'cache') };
  const cli = (...args) => execFileSync(process.execPath, [path.join(ENGINE_ROOT, 'bin', 'cascade.mjs'), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26 });
  cli('init', '--root', root, '--project', 'j6');
  const profile = JSON.parse(fs.readFileSync(path.join(root, '.cascade', 'profile.json'), 'utf8'));
  assert.equal(profile.jpa?.namingStrategy ?? null, null, 'init leaves the strategy to the run, which reads the configuration every time');
  const log = path.join(home, 'analyze.log');
  const fd = fs.openSync(log, 'w');
  let code = 0;
  try {
    execFileSync(process.execPath, [path.join(ENGINE_ROOT, 'bin', 'cascade.mjs'), 'analyze', '--root', root, '--project', 'j6'], { env, stdio: ['ignore', 'ignore', fd], maxBuffer: 1 << 26 });
  } catch (e) { code = e.status ?? 1; }
  fs.closeSync(fd);
  const stderr = fs.readFileSync(log, 'utf8');
  assert.equal(code, 0, stderr);
  const pack = JSON.parse(fs.readFileSync(path.join(root, '.cascade', 'pack', 'pack.json'), 'utf8'));
  const ids = new Set(pack.nodes.map((n) => n.id));
  assert.ok(ids.has('column:AGENT.hostName') && !ids.has('column:agent.host_name'), [...ids].filter((i) => i.startsWith('column:')).join(' '));
  assert.doesNotMatch(stderr, /JPA_NAMING_FROM_CONFIGURATION/, 'the configuration is not the factory\'s naming');
  assert.match(stderr, /JPA_NAMING_FROM_FACTORY jpa\.namingStrategy: .*src\/main\/java\/p\/DatabaseConfig\.java:7.*CamelCaseToUnderscoresNamingStrategy in src\/main\/resources\/application\.yml, which does not reach a factory the project builds itself/);
  assert.equal(pack.meta.axes.jpa.status, 'degraded');
  assert.match(pack.meta.axes.jpa.reason, /Hibernate's own default, which keeps a name as written, because the project builds its own EntityManagerFactory \(src\/main\/java\/p\/DatabaseConfig\.java:7\)/);
});

// ---------------------------------------------------------------------------
// the profile key itself (RM67-J7)
// ---------------------------------------------------------------------------

test('jpa.implicitNamingStrategy: a consumed key, spring or jpa-compliant, out of the digest until set', () => {
  const entry = PROFILE_KEY_CONSUMERS['jpa.implicitNamingStrategy'];
  assert.equal(entry.status, 'consumed');
  assert.equal(entry.where, 'src/adapters/jpa_naming.mjs');
  assert.doesNotThrow(() => validateProfile({ jpa: { implicitNamingStrategy: 'spring' } }));
  assert.doesNotThrow(() => validateProfile({ jpa: { implicitNamingStrategy: 'jpa-compliant' } }));
  assert.doesNotThrow(() => validateProfile({ jpa: { implicitNamingStrategy: null } }));
  assert.throws(() => validateProfile({ jpa: { implicitNamingStrategy: 'legacy-jpa' } }),
    (e) => e instanceof ProfileError && /must be null or one of spring\|jpa-compliant/.test(e.message),
    'a Hibernate class or short name this engine has not proven identical is not accepted as a new bucket');
  // Out of the digest at its default, the same promise tsBackend.typeorm.type keeps (KEYS_DIGESTED_WHEN_SET).
  assert.ok(KEYS_DIGESTED_WHEN_SET.includes('jpa.implicitNamingStrategy'));
  assert.deepEqual(digestedProfile(normalizeProfile({})).jpa, { namingStrategy: null }, 'a pack sealed before this key existed keeps its digest');
  assert.deepEqual(digestedProfile(normalizeProfile({ jpa: { implicitNamingStrategy: 'spring' } })).jpa,
    { namingStrategy: null, implicitNamingStrategy: 'spring' });
});
