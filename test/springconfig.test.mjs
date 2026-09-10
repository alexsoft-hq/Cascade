import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findServiceNames, findGatewayRoutes, findExternalConfigImports, looksLikeSpringConfigFile,
  springConfigEntries, resolvePlaceholder, frontPrefixOf, backPrefixOf, serviceOfUri,
  findViewResolvers, relaxedKey, findXmlViewResolvers, findDbTypeDeclarations,
  looksLikeSpringBeansXml, springBeansOf,
} from '../src/core/springconfig.mjs';
import { SQL_DIALECT_ALIASES } from '../src/core/profile.mjs';

// RM46 — the two facts a Spring project states about itself, read out of the
// tree instead of typed into a profile: the name it answers to, and the route
// table a gateway forwards with.
//
// Every fixture here is synthetic. The shape is the one Spring documents, and
// the names are invented, because a rule written against one project's spelling
// works on one project.

const YML = 'src/main/resources/application.yml';
const file = (text, at = YML) => [{ path: at, text }];

// ---------------------------------------------------------------------------
// Which file is a Spring configuration file at all
// ---------------------------------------------------------------------------

test('a Spring configuration file is named like one AND sits under resources', () => {
  for (const p of [
    'src/main/resources/application.yml',
    'src/main/resources/application.yaml',
    'src/main/resources/application-docker.yml',
    'src/main/resources/application.properties',
    'src/main/resources/bootstrap.yml',
    'gateway/src/main/resources/config/application.yml',
  ]) assert.equal(looksLikeSpringConfigFile(p), true, p);

  for (const p of [
    'application.yml',                                   // not under resources
    'src/main/resources/logback-spring.xml',             // not a config file
    'src/main/resources/messages.properties',            // a resource bundle
    'src/main/resources/static/app/application.yml',     // a presentation asset
    'src/main/resources/i18n/application.properties',
  ]) assert.equal(looksLikeSpringConfigFile(p), false, p);
});

// ---------------------------------------------------------------------------
// The service name
// ---------------------------------------------------------------------------

test('spring.application.name is read from the nested form and from the flat one', () => {
  assert.deepEqual(
    findServiceNames(file('spring:\n  application:\n    name: orders-service\n')),
    [{ name: 'orders-service', file: YML }],
  );
  assert.deepEqual(
    findServiceNames(file('spring.application.name: orders-service\n')),
    [{ name: 'orders-service', file: YML }],
  );
  assert.deepEqual(
    findServiceNames(file('spring.application.name=orders-service\n', 'src/main/resources/application.properties')),
    [{ name: 'orders-service', file: 'src/main/resources/application.properties' }],
  );
});

test('a ${VAR:default} name yields the default, a ${VAR} with none yields a diagnostic and no name', () => {
  assert.deepEqual(
    findServiceNames(file('spring:\n  application:\n    name: ${APP_NAME:orders-service}\n')),
    [{ name: 'orders-service', file: YML }],
  );
  const diags = [];
  assert.deepEqual(findServiceNames(file('spring:\n  application:\n    name: ${APP_NAME}\n'), diags), []);
  const hit = diags.find((d) => d.kind === 'SERVICE_NAME_UNREADABLE');
  assert.ok(hit, JSON.stringify(diags));
  assert.match(hit.reason, /names a value this tree does not carry/);
});

test('every document of a multi-document file is read, and the names come back sorted', () => {
  const text = 'spring:\n  application:\n    name: orders-service\n---\nspring:\n  config:\n    activate:\n      on-profile: docker\n  application:\n    name: another-name\n';
  assert.deepEqual(findServiceNames(file(text)).map((s) => s.name), ['another-name', 'orders-service']);
});

// ---------------------------------------------------------------------------
// The gateway route table
// ---------------------------------------------------------------------------

const GATEWAY = `spring:
  cloud:
    gateway:
      routes:
        - id: orders
          uri: lb://orders-service
          predicates:
            - Path=/api/order/**
          filters:
            - StripPrefix=2
        - id: billing
          uri: lb://billing-service
          predicates:
            - Path=/api/bill/**
          filters:
            - StripPrefix=1
        - id: legacy
          uri: http://legacy.invalid:8080
          predicates:
            - Path=/legacy/**
`;

test('a route becomes a front prefix, the prefix the back end sees, and the service it goes to', () => {
  const diags = [];
  assert.deepEqual(findGatewayRoutes(file(GATEWAY), diags), [
    { front: '/api/bill', to: '/bill', service: 'billing-service', file: YML, id: 'billing' },
    { front: '/api/order', to: '', service: 'orders-service', file: YML, id: 'orders' },
    { front: '/legacy', to: '/legacy', service: 'legacy.invalid', file: YML, id: 'legacy' },
  ]);
  assert.deepEqual(diags, []);
});

test('the 2025 key path is read as well as the classic one, and both in one file', () => {
  const text = `spring:
  cloud:
    gateway:
      server:
        webflux:
          routes:
            - id: orders
              uri: lb://orders-service
              predicates:
                - Path=/api/order/**
              filters:
                - StripPrefix=2
`;
  assert.deepEqual(findGatewayRoutes(file(text)), [
    { front: '/api/order', to: '', service: 'orders-service', file: YML, id: 'orders' },
  ]);
});

test('the flow spelling of a predicate and a filter list is read the same way', () => {
  const text = `spring:
  cloud:
    gateway:
      routes:
        - id: orders
          uri: lb://orders-service
          predicates: [Path=/api/order/**]
          filters: [StripPrefix=2]
`;
  assert.deepEqual(findGatewayRoutes(file(text)), [
    { front: '/api/order', to: '', service: 'orders-service', file: YML, id: 'orders' },
  ]);
});

test('the long form of a filter (name + args) is read as the shortcut form is', () => {
  const text = `spring:
  cloud:
    gateway:
      routes:
        - id: orders
          uri: lb://orders-service
          predicates:
            - name: Path
              args:
                patterns: /api/order/**
          filters:
            - name: StripPrefix
              args:
                parts: 1
`;
  assert.deepEqual(findGatewayRoutes(file(text)), [
    { front: '/api/order', to: '/order', service: 'orders-service', file: YML, id: 'orders' },
  ]);
});

test('a Path with several patterns becomes one entry each, and PrefixPath prepends', () => {
  const text = `spring:
  cloud:
    gateway:
      routes:
        - id: orders
          uri: lb://orders-service
          predicates:
            - Path=/api/order/**,/api/cart/**
          filters:
            - PrefixPath=/inner
`;
  assert.deepEqual(findGatewayRoutes(file(text)).map((r) => [r.front, r.to]), [
    ['/api/cart', '/inner/api/cart'],
    ['/api/order', '/inner/api/order'],
  ]);
});

test('RewritePath in the plain form Spring documents is applied to the prefix', () => {
  const text = `spring:
  cloud:
    gateway:
      routes:
        - id: orders
          uri: lb://orders-service
          predicates:
            - Path=/api/order/**
          filters:
            - RewritePath=/api/(?<segment>.*),/$\\{segment}
`;
  assert.deepEqual(findGatewayRoutes(file(text)), [
    { front: '/api/order', to: '/order', service: 'orders-service', file: YML, id: 'orders' },
  ]);
});

test('the three spellings of a RewritePath capture reference all mean the one group', () => {
  // Spring resolves `${…}` in a value as a property placeholder before the
  // gateway sees it, so its own reference tells YAML authors to write
  // `$\{segment}`. One more level of quoting makes it `$\\{segment}`. All three
  // are the same rule, and `$1` is the same rule again without a name.
  const route = (filters) => `spring:
  cloud:
    gateway:
      routes:
        - id: orders
          uri: lb://orders-service
          predicates:
            - Path=/api/order/**
          filters:
${filters.map((f) => `            - ${f}`).join('\n')}
`;
  for (const replacement of ['/${segment}', '/$\\{segment}', '/$\\\\{segment}']) {
    const diags = [];
    assert.deepEqual(
      findGatewayRoutes(file(route([`RewritePath=/api/(?<segment>.*),${replacement}`])), diags)
        .map((r) => [r.front, r.to]),
      [['/api/order', '/order']],
      replacement,
    );
    assert.deepEqual(diags, [], replacement);
  }
  // The unnamed group, referred to as `$1`, which is the other form the
  // reference shows.
  assert.deepEqual(
    findGatewayRoutes(file(route(['RewritePath=/api/(.*),/$1']))).map((r) => [r.front, r.to]),
    [['/api/order', '/order']],
  );
});

test('a RewritePath that writes the separator inside the pattern is the same prefix rule', () => {
  // The gateway of the eGovFrame MSA template, excerpted: the route table sits
  // under `server.webflux`, and each rewrite writes `/portal-service/` — the
  // prefix WITH its separator — so the prefix on its own does not match the
  // pattern and everything under it does. The rule it states is "take the
  // service name off the front", and that is what comes out.
  const text = `spring:
  cloud:
    gateway:
      server:
        webflux:
          routes:
            - id: portal-service
              uri: lb://PORTAL-SERVICE
              predicates:
                - Path=/portal-service/**
              filters:
                - RewritePath=/portal-service/(?<segment>.*), /$\\{segment}
            - id: board-service
              uri: lb://BOARD-SERVICE
              predicates:
                - Path=/board-service/**
              filters:
                - RemoveRequestHeader=Cookie
                - RewritePath=/board-service/(?<segment>.*), /$\\{segment}
`;
  const diags = [];
  assert.deepEqual(findGatewayRoutes(file(text), diags), [
    { front: '/board-service', to: '', service: 'BOARD-SERVICE', file: YML, id: 'board-service' },
    { front: '/portal-service', to: '', service: 'PORTAL-SERVICE', file: YML, id: 'portal-service' },
  ]);
  assert.deepEqual(diags, []);
});

test('a RewritePath replacement that names a group the pattern does not capture is refused', () => {
  // `(?<segment>.*)` captures `segment`, and `/$\\{other}` asks for something the
  // regular expression never captured. Reading the second as the first would
  // forward a path this route does not forward, so it is refused and the
  // mismatch is named.
  const route = (filter) => `spring:
  cloud:
    gateway:
      routes:
        - id: orders
          uri: lb://orders-service
          predicates:
            - Path=/api/order/**
          filters:
            - ${filter}
`;
  const named = [];
  assert.deepEqual(findGatewayRoutes(file(route('RewritePath=/api/(?<segment>.*),/$\\{other}')), named), []);
  const hit = named.find((d) => d.kind === 'GATEWAY_ROUTE_UNREADABLE');
  assert.ok(hit, JSON.stringify(named));
  assert.match(hit.reason, /refers to "other" and its regular expression captures "segment"/);

  // The same the other way round: an UNNAMED group and a named reference.
  const unnamed = [];
  assert.deepEqual(findGatewayRoutes(file(route('RewritePath=/api/(.*),/$\\{segment}')), unnamed), []);
  const miss = unnamed.find((d) => d.kind === 'GATEWAY_ROUTE_UNREADABLE');
  assert.ok(miss, JSON.stringify(unnamed));
  assert.match(miss.reason, /captures a group with no name/);

  // And `$1` still means the one group, named or not.
  assert.deepEqual(
    findGatewayRoutes(file(route('RewritePath=/api/(?<segment>.*),/$1'))).map((r) => [r.front, r.to]),
    [['/api/order', '/order']],
  );
});

test('a RewritePath whose pattern starts somewhere else is still refused', () => {
  // `/api/v1/` is neither the prefix nor the prefix plus its separator: which
  // requests under `/api/order` it rewrites depends on the rest of the path,
  // and there is no one prefix rule to read out of it.
  const text = `spring:
  cloud:
    gateway:
      routes:
        - id: orders
          uri: lb://orders-service
          predicates:
            - Path=/api/order/**
          filters:
            - RewritePath=/api/v1/(?<segment>.*),/$\\{segment}
`;
  const diags = [];
  assert.deepEqual(findGatewayRoutes(file(text), diags), []);
  const hit = diags.find((d) => d.kind === 'GATEWAY_ROUTE_UNREADABLE');
  assert.ok(hit, JSON.stringify(diags));
  assert.match(hit.reason, /does not match the prefix/);
});

test('a rewrite this reader does not understand is a diagnostic and NO entry, never a guess', () => {
  const text = `spring:
  cloud:
    gateway:
      routes:
        - id: orders
          uri: lb://orders-service
          predicates:
            - Path=/api/order/**
          filters:
            - RewritePath=/api/(one|two)/(?<rest>.*),/$\\{rest}
`;
  const diags = [];
  assert.deepEqual(findGatewayRoutes(file(text), diags), []);
  const hit = diags.find((d) => d.kind === 'GATEWAY_ROUTE_UNREADABLE');
  assert.ok(hit, JSON.stringify(diags));
  assert.equal(hit.path, YML);
  assert.match(hit.reason, /^orders: /);
  assert.match(hit.reason, /outside the plain/);
});

test('a filter that sets the whole path, and a wildcard inside a pattern, are refused by name', () => {
  const setPath = `spring:
  cloud:
    gateway:
      routes:
        - id: orders
          uri: lb://orders-service
          predicates:
            - Path=/api/order/**
          filters:
            - SetPath=/inner/fixed
`;
  const d1 = [];
  assert.deepEqual(findGatewayRoutes(file(setPath), d1), []);
  assert.match(d1.find((d) => d.kind === 'GATEWAY_ROUTE_UNREADABLE').reason, /sets the whole forwarded path/);

  const middle = `spring:
  cloud:
    gateway:
      routes:
        - id: orders
          uri: lb://orders-service
          predicates:
            - Path=/api/*/order/**
`;
  const d2 = [];
  assert.deepEqual(findGatewayRoutes(file(middle), d2), []);
  assert.match(d2.find((d) => d.kind === 'GATEWAY_ROUTE_UNREADABLE').reason, /is not a path PREFIX/);
});

test('a route matched by something other than a path contributes nothing at all', () => {
  const text = `spring:
  cloud:
    gateway:
      routes:
        - id: byhost
          uri: lb://orders-service
          predicates:
            - Host=**.example.com
          filters:
            - StripPrefix=1
`;
  const diags = [];
  assert.deepEqual(findGatewayRoutes(file(text), diags), []);
  assert.deepEqual(diags, []);
});

test('a Host predicate written in the long form is not mistaken for a path', () => {
  const text = `spring:
  cloud:
    gateway:
      routes:
        - id: byhost
          uri: lb://orders-service
          predicates:
            - name: Host
              args:
                patterns: '**.example.com'
`;
  assert.deepEqual(findGatewayRoutes(file(text)), []);
});

test('the .properties spelling of a route table reads exactly the same', () => {
  const text = [
    'spring.application.name=edge-service',
    'spring.cloud.gateway.routes[0].id=orders',
    'spring.cloud.gateway.routes[0].uri=lb://orders-service',
    'spring.cloud.gateway.routes[0].predicates[0]=Path=/api/order/**',
    'spring.cloud.gateway.routes[0].filters[0]=StripPrefix=2',
    'spring.cloud.gateway.routes[1].id=billing',
    'spring.cloud.gateway.routes[1].uri=lb://billing-service',
    'spring.cloud.gateway.routes[1].predicates[0]=Path=/api/bill/**',
    '',
  ].join('\n');
  const at = 'src/main/resources/application.properties';
  assert.deepEqual(findGatewayRoutes([{ path: at, text }]), [
    { front: '/api/bill', to: '/api/bill', service: 'billing-service', file: at, id: 'billing' },
    { front: '/api/order', to: '', service: 'orders-service', file: at, id: 'orders' },
  ]);
  assert.deepEqual(findServiceNames([{ path: at, text }]), [{ name: 'edge-service', file: at }]);
});

// ---------------------------------------------------------------------------
// Configuration that is not in this tree
// ---------------------------------------------------------------------------

test('a config server import is reported, so a partial route table is not read as the whole one', () => {
  const text = 'spring:\n  config:\n    import: optional:configserver:http://localhost:8888/\n';
  assert.deepEqual(findExternalConfigImports(file(text)),
    [{ file: YML, value: 'optional:configserver:http://localhost:8888/' }]);
  // A plain file import is not one: the file is in the tree.
  assert.deepEqual(findExternalConfigImports(file('spring:\n  config:\n    import: classpath:extra.yml\n')), []);
});

// ---------------------------------------------------------------------------
// The pieces, one at a time
// ---------------------------------------------------------------------------

test('resolvePlaceholder: a default is a value, a bare variable is not, a built name is not', () => {
  assert.equal(resolvePlaceholder('plain'), 'plain');
  assert.equal(resolvePlaceholder('${A:fallback}'), 'fallback');
  assert.equal(resolvePlaceholder('${A}'), null);
  assert.equal(resolvePlaceholder('${A:}'), null);
  assert.equal(resolvePlaceholder('prefix-${A:b}'), null);
  assert.equal(resolvePlaceholder('${A:${B:c}}'), null);
  assert.equal(resolvePlaceholder(''), null);
});

test('frontPrefixOf: the tail wildcard goes, a middle one refuses the whole pattern', () => {
  assert.equal(frontPrefixOf('/api/order/**'), '/api/order');
  assert.equal(frontPrefixOf('/api/order/*'), '/api/order');
  assert.equal(frontPrefixOf('/api/order'), '/api/order');
  assert.equal(frontPrefixOf('api/order/**'), '/api/order');
  assert.equal(frontPrefixOf('/api/*/order/**'), null);
  assert.equal(frontPrefixOf('/api/{id}/**'), null);
  assert.equal(frontPrefixOf(''), null);
});

test('backPrefixOf: the three filters, and what happens when there is none', () => {
  const where = { file: YML, label: 'r', diagnostics: null };
  assert.equal(backPrefixOf('/api/order', [], where), '/api/order');
  assert.equal(backPrefixOf('/api/order', ['StripPrefix=2'], where), '');
  assert.equal(backPrefixOf('/api/order', ['StripPrefix=1'], where), '/order');
  assert.equal(backPrefixOf('/api/order', ['StripPrefix=9'], where), '');
  assert.equal(backPrefixOf('/api/order', ['PrefixPath=/inner'], where), '/inner/api/order');
  assert.equal(backPrefixOf('/api/order', ['CircuitBreaker=name=x'], where), '/api/order');
  // Two filters compose, in the order the file wrote them.
  assert.equal(backPrefixOf('/api/order', ['StripPrefix=1', 'PrefixPath=/inner'], where), '/inner/order');
  // A path filter whose arguments were not found refuses the route.
  assert.equal(backPrefixOf('/api/order', ['StripPrefix'], where), null);
});

test('serviceOfUri: lb:// names a service, http:// names a host, a placeholder names nothing', () => {
  assert.equal(serviceOfUri('lb://orders-service'), 'orders-service');
  assert.equal(serviceOfUri('http://legacy.invalid:8080/base'), 'legacy.invalid');
  assert.equal(serviceOfUri('${ORDERS_URI}'), null);
  assert.equal(serviceOfUri(null), null);
  assert.equal(serviceOfUri('not-a-uri'), null);
});

test('springConfigEntries reads only the keys this module is about', () => {
  const text = 'spring:\n  application:\n    name: x\n  datasource:\n    url: jdbc:mysql://h/db\nserver:\n  port: 8080\n';
  assert.deepEqual(springConfigEntries({ path: YML, text }).map((e) => e.key), ['spring.application.name']);
});

// ---------------------------------------------------------------------------
// RM48 — the view resolver: where a view name becomes a page
// ---------------------------------------------------------------------------

test('a key is read in the three spellings Spring binds it from', () => {
  assert.equal(relaxedKey('spring.freemarker.templateLoaderPath'), 'spring.freemarker.template-loader-path');
  assert.equal(relaxedKey('spring.freemarker.TEMPLATE_LOADER_PATH'), 'spring.freemarker.template-loader-path');
  assert.equal(relaxedKey('spring.thymeleaf.prefix'), 'spring.thymeleaf.prefix');
});

test('the view resolver settings are read per engine, in properties and in YAML', () => {
  assert.deepEqual(
    findViewResolvers(file('spring.freemarker.templateLoaderPath=classpath:/tpl/\nspring.freemarker.suffix=.ftl\n',
      'src/main/resources/application.properties')),
    [{ engine: 'freemarker', prefix: 'classpath:/tpl/', suffix: '.ftl', file: 'src/main/resources/application.properties', line: 1 }],
  );
  assert.deepEqual(
    findViewResolvers(file('spring:\n  thymeleaf:\n    prefix: classpath:/views/\n    suffix: .htm\n')),
    [{ engine: 'thymeleaf', prefix: 'classpath:/views/', suffix: '.htm', file: YML, line: 3 }],
  );
  // `spring.mvc.view.*` is Spring MVC's own resolver, which is what a JSP
  // application configures.
  assert.deepEqual(
    findViewResolvers(file('spring:\n  mvc:\n    view:\n      prefix: /WEB-INF/jsp/\n      suffix: .jsp\n')),
    [{ engine: 'jsp', prefix: '/WEB-INF/jsp/', suffix: '.jsp', file: YML, line: 4 }],
  );
  // A LIST loader path: the first entry is the one a view name is resolved
  // against first, and it is the one read.
  assert.deepEqual(
    findViewResolvers(file('spring:\n  freemarker:\n    template-loader-path:\n      - classpath:/a/\n      - classpath:/b/\n'))
      .map((r) => r.prefix),
    ['classpath:/a/'],
  );
});

test('a project that only TURNS AN ENGINE ON still names the engine, with no prefix invented', () => {
  // `spring.thymeleaf.mode=HTML` says which engine renders the pages and
  // nothing about where they are. The prefix stays null, and whoever joins
  // these onto a tree applies the engine's documented default.
  assert.deepEqual(
    findViewResolvers(file('spring.thymeleaf.mode=HTML\n', 'src/main/resources/application.properties')),
    [{ engine: 'thymeleaf', prefix: null, suffix: null, file: 'src/main/resources/application.properties', line: 1 }],
  );
  // A file that says nothing about a view resolver yields nothing.
  assert.deepEqual(findViewResolvers(file('spring:\n  application:\n    name: a\n')), []);
});

// ---------------------------------------------------------------------------
// RM55 — the same settings, written as Spring BEANS
//
// A Spring MVC application written before Boot puts its view resolver in an XML
// bean definition, which is what eGovFrame does and what the Korean public
// sector runs. Same question, same record shape, different spelling.
// ---------------------------------------------------------------------------

const SERVLET_XML = `<?xml version="1.0" encoding="UTF-8"?>
<beans xmlns="http://www.springframework.org/schema/beans"
       xmlns:p="http://www.springframework.org/schema/p">

    <bean class="org.springframework.web.servlet.view.BeanNameViewResolver" p:order="0"/>

    <bean class="org.springframework.web.servlet.view.UrlBasedViewResolver" p:order="1"
        p:viewClass="org.springframework.web.servlet.view.JstlView"
        p:prefix="/WEB-INF/jsp/" p:suffix=".jsp"/>

    <!--
    <bean class="org.springframework.web.servlet.view.InternalResourceViewResolver"
        p:prefix="/WEB-INF/commented/" p:suffix=".jsp"/>
    -->
</beans>
`;

const PROPERTY_XML = `<?xml version="1.0"?>
<beans xmlns="http://www.springframework.org/schema/beans">
    <bean id="viewResolver" class="org.springframework.web.servlet.view.InternalResourceViewResolver">
        <property name="prefix" value="/WEB-INF/pages/" />
        <property name="suffix" value=".jsp" />
    </bean>
</beans>
`;

test('a Spring bean XML is read by its ROOT ELEMENT, never by its file name', () => {
  assert.equal(looksLikeSpringBeansXml(SERVLET_XML), true);
  assert.equal(looksLikeSpringBeansXml('<?xml version="1.0"?>\n<mapper namespace="X"><select id="a">SELECT 1</select></mapper>'), false);
});

test('a view resolver declared as a bean comes out in the same shape as one in YAML', () => {
  const found = findXmlViewResolvers([{ path: 'src/main/webapp/WEB-INF/config/dispatcher-servlet.xml', text: SERVLET_XML }]);
  // The BeanNameViewResolver resolves a view name against beans, not against a
  // directory, so it names no template root and yields no record.
  assert.equal(found.length, 1, 'one resolver: a bean with no prefix and no suffix is not one');
  assert.equal(found[0].engine, 'jsp');
  assert.equal(found[0].prefix, '/WEB-INF/jsp/');
  assert.equal(found[0].suffix, '.jsp');
  assert.equal(found[0].order, 1);
  assert.equal(found[0].line, 7, 'the line is the bean\'s own, counted through the comment');
  // A COMMENTED-OUT BEAN IS NOT A BEAN.
  assert.equal(found.some((r) => r.prefix === '/WEB-INF/commented/'), false);
});

test('a property written as a child element reads the same as the p: shorthand', () => {
  const found = findXmlViewResolvers([{ path: 'WEB-INF/spring-mvc.xml', text: PROPERTY_XML }]);
  assert.deepEqual(found.map((r) => [r.engine, r.prefix, r.suffix]), [['jsp', '/WEB-INF/pages/', '.jsp']]);
});

test('springBeansOf reads a bean\'s own body, and an inner bean does not end it early', () => {
  const xml = `<beans>
  <bean id="outer" class="com.x.Outer">
    <property name="delegate">
      <bean class="com.x.Inner"/>
    </property>
    <property name="prefix" value="/WEB-INF/jsp/"/>
  </bean>
</beans>`;
  const beans = springBeansOf(xml);
  const outer = beans.find((b) => b.className === 'com.x.Outer');
  assert.equal(outer.props.get('prefix'), '/WEB-INF/jsp/', 'the property AFTER the inner bean is still the outer\'s');
});

test('a DbType-shaped property names the database vendor, and only a routable one', () => {
  const routable = (v) => Object.hasOwn(SQL_DIALECT_ALIASES, v);
  const globals = [{ path: 'src/main/resources/egovProps/globals.properties', text: 'Globals.DbType = mysql\nGlobals.Url = jdbc:mysql://127.0.0.1:3306/x\n' }];
  assert.deepEqual(findDbTypeDeclarations(globals, routable),
    [{ vendor: 'mysql', key: 'Globals.DbType', file: 'src/main/resources/egovProps/globals.properties', line: 1 }]);
  // The key SHAPE, not one project's spelling.
  assert.deepEqual(findDbTypeDeclarations([{ path: 'a.properties', text: 'app.db-type=tibero\n' }], routable).map((d) => d.vendor), ['tibero']);
  assert.deepEqual(findDbTypeDeclarations([{ path: 'a.properties', text: 'Globals.DbType=hsql\n' }], routable).map((d) => d.vendor), ['hsqldb']);
  // A value this engine cannot route is somebody's own word for a product.
  assert.deepEqual(findDbTypeDeclarations([{ path: 'a.properties', text: 'Globals.DbType=dm8\n' }], routable), []);
  // A key that is not asking which database this is.
  assert.deepEqual(findDbTypeDeclarations([{ path: 'a.properties', text: 'Globals.DbTypeLabel=mysql\n' }], routable), []);
});
