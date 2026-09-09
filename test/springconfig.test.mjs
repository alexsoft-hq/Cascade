import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findServiceNames, findGatewayRoutes, findExternalConfigImports, looksLikeSpringConfigFile,
  springConfigEntries, resolvePlaceholder, frontPrefixOf, backPrefixOf, serviceOfUri,
} from '../src/core/springconfig.mjs';

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
