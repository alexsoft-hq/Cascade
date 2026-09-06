import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findConnectionCandidates, parseConnectionUrl, redactUrl, refFor,
  readSpringDatasourceYaml, parseProperties, parseDotenv, kindOfFile,
  looksLikeConnectionFile, PASSWORD_LITERAL_REF, DEFAULT_PORTS,
} from '../src/core/dbconfig.mjs';

// src/core/dbconfig.mjs reads a project's datasource configuration (SPEC §12.1
// ①). Two things are being tested here, and the second one matters more than
// the first:
//
//   1. that every URL and file form the spec names is READ correctly;
//   2. that a password VALUE never survives into the result — not as a field,
//      not inside the returned URL, not in a diagnostic. Every fixture below
//      that has a password uses a distinctive literal, and the assertion is
//      made against the JSON of the WHOLE result, not against the field the
//      implementation happens to think holds it.

// The literal every leak assertion hunts for. It appears in fixtures only.
const SECRET = 'pw-LITERAL-9f3a1';

const noSecret = (value, what) => {
  const json = JSON.stringify(value);
  assert.equal(json.includes(SECRET), false,
    `${what} carries the literal password ${SECRET}: ${json}`);
};

// ---------------------------------------------------------------------------
// URL forms (SPEC §12)
// ---------------------------------------------------------------------------

test('parseConnectionUrl: jdbc:mysql with host, port, database and parameters', () => {
  const r = parseConnectionUrl('jdbc:mysql://db.example.com:3306/shop?useUnicode=true&serverTimezone=UTC');
  assert.equal(r.dialect, 'mysql');
  assert.equal(r.host, 'db.example.com');
  assert.equal(r.port, 3306);
  assert.equal(r.database, 'shop');
  assert.equal(r.passwordPresent, false);
});

test('parseConnectionUrl: jdbc:mariadb reads as the mysql dialect', () => {
  const r = parseConnectionUrl('jdbc:mariadb://db.example.com/shop');
  assert.equal(r.dialect, 'mysql');
  assert.equal(r.host, 'db.example.com');
  assert.equal(r.port, null, 'a port the URL did not state is not invented here');
  assert.equal(DEFAULT_PORTS.mysql, 3306, 'the default is a constant the CALLER applies, visibly');
});

test('parseConnectionUrl: jdbc:postgresql', () => {
  const r = parseConnectionUrl('jdbc:postgresql://pg.example.com:5432/shop');
  assert.equal(r.dialect, 'postgres');
  assert.equal(r.host, 'pg.example.com');
  assert.equal(r.port, 5432);
  assert.equal(r.database, 'shop');
});

test('parseConnectionUrl: the two Oracle thin forms', () => {
  const service = parseConnectionUrl('jdbc:oracle:thin:@//ora.example.com:1521/ORCLPDB1');
  assert.equal(service.dialect, 'oracle');
  assert.equal(service.host, 'ora.example.com');
  assert.equal(service.port, 1521);
  assert.equal(service.database, 'ORCLPDB1');

  const sid = parseConnectionUrl('jdbc:oracle:thin:@ora.example.com:1521:ORCL');
  assert.equal(sid.host, 'ora.example.com');
  assert.equal(sid.port, 1521);
  assert.equal(sid.database, 'ORCL');
});

test('parseConnectionUrl: the driver-less postgres:// and mysql:// forms', () => {
  assert.equal(parseConnectionUrl('postgres://pg.example.com:5432/shop').dialect, 'postgres');
  assert.equal(parseConnectionUrl('postgresql://pg.example.com/shop').dialect, 'postgres');
  assert.equal(parseConnectionUrl('mysql://db.example.com/shop').dialect, 'mysql');
});

test('parseConnectionUrl: an unknown scheme yields a null dialect, never a guess', () => {
  const r = parseConnectionUrl('jdbc:sqlserver://sql.example.com:1433;databaseName=shop');
  assert.equal(r.dialect, null);
});

test('parseConnectionUrl: what is not a connection URL at all is not one', () => {
  assert.equal(parseConnectionUrl('http://example.com/v1'), null);
  assert.equal(parseConnectionUrl('redis://localhost:6379'), null);
  assert.equal(parseConnectionUrl(''), null);
  assert.equal(parseConnectionUrl(null), null);
});

test('parseConnectionUrl: several hosts are reported, and the first one is used', () => {
  const r = parseConnectionUrl('jdbc:mysql://a.example.com:3306,b.example.com:3306/shop');
  assert.equal(r.host, 'a.example.com');
  assert.equal(r.port, 3306);
  assert.match(r.notes.join(' '), /several hosts/);
});

test('parseConnectionUrl: an Oracle TNS descriptor is declared unread, not half-read', () => {
  const r = parseConnectionUrl('jdbc:oracle:thin:@(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=ora.example.com)(PORT=1521)))');
  assert.equal(r.dialect, 'oracle');
  assert.equal(r.host, null);
  assert.match(r.notes.join(' '), /TNS descriptor/);
});

// --- passwords inside a URL ------------------------------------------------

test('a password in the URL userinfo is redacted out of the returned url', () => {
  const r = parseConnectionUrl(`postgres://app:${SECRET}@pg.example.com:5432/shop`);
  assert.equal(r.usernameRef, 'app');
  assert.equal(r.passwordPresent, true);
  assert.equal(r.passwordRef, PASSWORD_LITERAL_REF);
  assert.equal(r.url, 'postgres://app:***@pg.example.com:5432/shop');
  noSecret(r, 'parseConnectionUrl(userinfo)');
});

test('a password in a query parameter is redacted out of the returned url', () => {
  const r = parseConnectionUrl(`jdbc:mysql://db.example.com:3306/shop?user=app&password=${SECRET}`);
  assert.equal(r.usernameRef, 'app');
  assert.equal(r.passwordPresent, true);
  assert.equal(r.url, 'jdbc:mysql://db.example.com:3306/shop?user=app&password=***');
  noSecret(r, 'parseConnectionUrl(query)');
});

test('a password in the Oracle user/password@ prefix is redacted out', () => {
  const r = parseConnectionUrl(`jdbc:oracle:thin:scott/${SECRET}@//ora.example.com:1521/ORCLPDB1`);
  assert.equal(r.usernameRef, 'scott');
  assert.equal(r.passwordPresent, true);
  assert.equal(r.url, 'jdbc:oracle:thin:scott/***@//ora.example.com:1521/ORCLPDB1');
  noSecret(r, 'parseConnectionUrl(oracle creds)');
});

test('redactUrl leaves a URL with no secret in it exactly as it was', () => {
  const url = 'jdbc:mysql://db.example.com:3306/shop?useUnicode=true';
  assert.equal(redactUrl(url), url);
});

test('refFor keeps a ${VAR} placeholder and never the literal', () => {
  assert.equal(refFor('${DB_PASSWORD}'), '${DB_PASSWORD}');
  assert.equal(refFor(SECRET), PASSWORD_LITERAL_REF);
});

// ---------------------------------------------------------------------------
// .properties
// ---------------------------------------------------------------------------

const SPRING_PROPERTIES = `# com.example shop
spring.application.name=shop
spring.datasource.url=jdbc:mysql://db.example.com:3306/shop?useUnicode=true
spring.datasource.username=shop_app
spring.datasource.password=${SECRET}
spring.jpa.show-sql=true
`;

test('spring.datasource.* in a .properties file', () => {
  const found = findConnectionCandidates([{ path: 'src/main/resources/application.properties', text: SPRING_PROPERTIES }]);
  assert.equal(found.length, 1);
  const c = found[0];
  assert.equal(c.kind, 'spring-properties');
  assert.equal(c.dialect, 'mysql');
  assert.equal(c.host, 'db.example.com');
  assert.equal(c.port, 3306);
  assert.equal(c.database, 'shop');
  assert.equal(c.usernameRef, 'shop_app');
  assert.equal(c.passwordPresent, true);
  assert.equal(c.passwordRef, PASSWORD_LITERAL_REF);
  noSecret(found, 'a .properties candidate');
});

test('spring.datasource.hikari.jdbc-url inherits the shared username and password', () => {
  const text = `spring.datasource.username=shop_app
spring.datasource.password=${SECRET}
spring.datasource.hikari.jdbc-url=jdbc:postgresql://pg.example.com:5432/shop
`;
  const found = findConnectionCandidates([{ path: 'application.properties', text }]);
  assert.equal(found.length, 1);
  assert.equal(found[0].dialect, 'postgres');
  assert.equal(found[0].usernameRef, 'shop_app');
  assert.equal(found[0].passwordPresent, true);
  noSecret(found, 'a hikari candidate');
});

test('the multi-datasource form yields one candidate per named datasource', () => {
  const text = `spring.datasource.primary.url=jdbc:mysql://a.example.com:3306/shop
spring.datasource.primary.username=writer
spring.datasource.replica.url=jdbc:mysql://b.example.com:3306/shop
spring.datasource.replica.username=reader
`;
  const found = findConnectionCandidates([{ path: 'application.properties', text }]);
  assert.equal(found.length, 2);
  assert.deepEqual(found.map((c) => c.host).sort(), ['a.example.com', 'b.example.com']);
  assert.deepEqual(found.map((c) => c.usernameRef).sort(), ['reader', 'writer']);
});

test('a non-Spring properties file with a jdbc URL is still found, as kind jdbc-url', () => {
  const text = `jdbc.driverClass=com.mysql.cj.jdbc.Driver
jdbc.connectionURL=jdbc:mysql://db.example.com:3306/shop
jdbc.userId=generator
jdbc.password=${SECRET}
`;
  const found = findConnectionCandidates([{ path: 'generator.properties', text }]);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'jdbc-url');
  assert.equal(found[0].usernameRef, 'generator');
  assert.equal(found[0].passwordPresent, true);
  noSecret(found, 'a generator.properties candidate');
});

test('parseProperties: comments, colon separators and line continuations', () => {
  const entries = parseProperties('# a comment\n! another\na:1\nb = 2\nc = long\\\n  tail\n');
  assert.deepEqual(entries.map((e) => [e.key, e.value]), [['a', '1'], ['b', '2'], ['c', 'longtail']]);
});

test('parseProperties: unreadable lines become ONE diagnostic per file, and only in a datasource file', () => {
  // A file that holds a datasource key: the lines this reader could not read are
  // a real gap in a real connection file, and it says how many and which.
  const d = [];
  parseProperties('this line has no separator\nspring.datasource.url=jdbc:mysql://db.example.com/shop\nnor does this\n',
    d, 'x.properties');
  assert.equal(d.length, 1, `one diagnostic per FILE, got ${d.length}`);
  assert.equal(d[0].kind, 'UNREADABLE_PROPERTY_LINE');
  assert.match(d[0].reason, /2 line\(s\)/);
  assert.match(d[0].reason, /lines 1, 3/);

  // A file that holds NO datasource key is not this module's business, however
  // unreadable it is: jeecg-boot's PDF.js locale bundle produced 208 of these.
  const quiet = [];
  const locale = Array.from({ length: 40 }, (_, i) => `#${i} not a pair`).join('\n');
  parseProperties(locale, quiet, 'locale.properties');
  assert.deepEqual(quiet, []);
  const quiet2 = [];
  parseProperties('this line has no separator\ntitle: Some UI Label\n', quiet2, 'ui.properties');
  assert.deepEqual(quiet2, []);
});

test('looksLikeConnectionFile: a presentation resource is not read at all', () => {
  // The whole point of the path rule: these carry no datasource and never did.
  for (const p of [
    'app/src/main/resources/static/generic/web/locale/locale.properties',
    'app/src/main/resources/static/generic/web/locale/zh-CN/viewer.properties',
    'app/src/main/resources/i18n/message_zh_CN.properties',
    'app/src/main/resources/public/config.yml',
    'app/src/main/resources/templates/mail.properties',
    'app/src/main/resources/messages/messages_de.properties',
    'app/src/main/resources/messages.properties',
    'app/locales/app_fr_FR.properties',
  ]) {
    assert.equal(looksLikeConnectionFile(p), false, `${p} should not be read for connection info`);
  }
  // …and the rule must not eat a real config. `app_db.properties` ends in a
  // two-letter suffix and is NOT a locale: only `_xx_XX` is treated as one.
  for (const p of [
    'app/src/main/resources/application.yml',
    'app/src/main/resources/application-dev.yml',
    'app/src/main/resources/jeecg/jeecg_database.properties',
    'app/src/main/resources/app_db.properties',
    'app/config/.env',
    'static-assets/application.properties', // a directory NAMED static-assets is not `static`
  ]) {
    assert.equal(looksLikeConnectionFile(p), true, `${p} must still be read`);
  }
});

// ---------------------------------------------------------------------------
// application.yml — the minimal reader
// ---------------------------------------------------------------------------

const SPRING_YML = `spring:
  application:
    name: shop
  datasource:
    url: jdbc:mysql://db.example.com:3306/shop?useUnicode=true&serverTimezone=UTC # the main DB
    username: shop_app
    password: ${SECRET}
    druid:
      initial-size: 5
      stat-view-servlet:
        login-username: druid
        login-password: druid-console-pw
  data:
    redis:
      host: localhost
      password:
`;

test('the yml reader reads spring.datasource and nothing else', () => {
  const found = findConnectionCandidates([{ path: 'application.yml', text: SPRING_YML }]);
  assert.equal(found.length, 1, 'druid`s console login and the redis password are not datasources');
  const c = found[0];
  assert.equal(c.kind, 'spring-yml');
  assert.equal(c.host, 'db.example.com');
  assert.equal(c.port, 3306);
  assert.equal(c.database, 'shop');
  assert.equal(c.usernameRef, 'shop_app');
  assert.equal(c.passwordPresent, true);
  noSecret(found, 'a spring-yml candidate');
  assert.equal(JSON.stringify(found).includes('druid-console-pw'), false,
    'a password under the datasource subtree that is NOT the datasource password must not be reported as one');
});

test('the yml reader strips a trailing comment but keeps a URL fragment', () => {
  const leaves = readSpringDatasourceYaml('spring:\n  datasource:\n    url: jdbc:mysql://h/db?a=1#b # comment\n');
  assert.deepEqual(leaves.map((l) => [l.keyPath.join('.'), l.value]),
    [['url', 'jdbc:mysql://h/db?a=1#b']]);
});

test('the yml reader handles quoted scalars', () => {
  const leaves = readSpringDatasourceYaml(
    'spring:\n  datasource:\n    username: \'shop app\'\n    url: "jdbc:mysql://h/db"\n',
  );
  const byKey = Object.fromEntries(leaves.map((l) => [l.keyPath.join('.'), l.value]));
  assert.equal(byKey.username, 'shop app');
  assert.equal(byKey.url, 'jdbc:mysql://h/db');
});

test('the yml reader splits --- documents and keeps them apart', () => {
  const text = `spring:
  datasource:
    url: jdbc:mysql://dev.example.com/shop
---
spring:
  datasource:
    url: jdbc:mysql://prod.example.com/shop
`;
  const leaves = readSpringDatasourceYaml(text);
  assert.deepEqual(leaves.map((l) => [l.doc, l.value]), [
    [0, 'jdbc:mysql://dev.example.com/shop'],
    [1, 'jdbc:mysql://prod.example.com/shop'],
  ]);
  const found = findConnectionCandidates([{ path: 'application.yml', text }]);
  assert.deepEqual(found.map((c) => c.host).sort(), ['dev.example.com', 'prod.example.com']);
});

test('a key with no value and no children is an EMPTY scalar, not a mapping', () => {
  const leaves = readSpringDatasourceYaml('spring:\n  datasource:\n    url: jdbc:mysql://h/db\n    password:\n');
  const byKey = Object.fromEntries(leaves.map((l) => [l.keyPath.join('.'), l.value]));
  assert.equal(byKey.password, null);
  const found = findConnectionCandidates([{ path: 'a.yml', text: 'spring:\n  datasource:\n    url: jdbc:mysql://h/db\n    password:\n' }]);
  assert.equal(found[0].passwordPresent, false, 'an empty password key is NOT a password');
});

test('a YAML construct the reader cannot read is a diagnostic, never a guess', () => {
  for (const [label, line] of [
    ['sequence', '    - jdbc:mysql://h/db'],
    ['block scalar', '    url: |'],
    ['flow mapping', '    url: {a: b}'],
    ['alias', '    url: *base'],
  ]) {
    const d = [];
    const found = findConnectionCandidates(
      [{ path: 'a.yml', text: `spring:\n  datasource:\n${line}\n` }], d,
    );
    assert.equal(found.length, 0, `${label} must not become a candidate`);
    assert.equal(d.length, 1, `${label} must leave a diagnostic`);
    assert.equal(d[0].kind, 'UNSUPPORTED_YAML');
  }
});

test('a tab-indented line inside the subtree is refused with a diagnostic', () => {
  const d = [];
  readSpringDatasourceYaml('spring:\n  datasource:\n\turl: jdbc:mysql://h/db\n', d, 'a.yml');
  assert.equal(d[0].kind, 'UNSUPPORTED_YAML');
  assert.match(d[0].reason, /tab/);
});

test('a yml with no spring.datasource subtree yields nothing and complains about nothing', () => {
  const d = [];
  const found = findConnectionCandidates(
    [{ path: 'docker-compose.yml', text: 'services:\n  db:\n    image: mysql:8\n    environment:\n      - MYSQL_ROOT_PASSWORD=x\n' }], d,
  );
  assert.deepEqual(found, []);
  assert.deepEqual(d, [], 'a file that is none of this reader’s business is not commented on');
});

// ---------------------------------------------------------------------------
// .env
// ---------------------------------------------------------------------------

test('.env: the documented keys, with a literal password', () => {
  const text = `# local only
export DB_URL=jdbc:postgresql://pg.example.com:5432/shop
DB_USER=shop_app
DB_PASSWORD=${SECRET}
`;
  const found = findConnectionCandidates([{ path: 'db.env', text }]);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'dotenv');
  assert.equal(found[0].dialect, 'postgres');
  assert.equal(found[0].usernameRef, 'shop_app');
  assert.equal(found[0].passwordPresent, true);
  assert.equal(found[0].passwordRef, PASSWORD_LITERAL_REF);
  noSecret(found, 'a dotenv candidate');
});

test('.env: a ${VAR} placeholder is kept as a reference and never resolved from the process env', () => {
  process.env.CASCADE_TEST_DB_USER = 'resolved-from-the-shell';
  try {
    const text = 'DATABASE_URL=jdbc:mysql://db.example.com:3306/shop\n'
      + 'DB_USER=${CASCADE_TEST_DB_USER}\n'
      + 'DB_PASSWORD=${CASCADE_TEST_DB_PASSWORD}\n';
    const found = findConnectionCandidates([{ path: '.env', text }]);
    assert.equal(found[0].usernameRef, '${CASCADE_TEST_DB_USER}');
    assert.equal(found[0].passwordPresent, true);
    assert.equal(found[0].passwordRef, '${CASCADE_TEST_DB_PASSWORD}');
    assert.equal(JSON.stringify(found).includes('resolved-from-the-shell'), false,
      'a parser that reads process.env makes its answer depend on the shell that ran it');
  } finally {
    delete process.env.CASCADE_TEST_DB_USER;
  }
});

test('.env: quotes are stripped and a trailing comment is not part of the value', () => {
  const entries = parseDotenv('A="one two"\nB=three # note\nC=\'four\'\n');
  assert.deepEqual(entries.map((e) => [e.key, e.value]), [['A', 'one two'], ['B', 'three'], ['C', 'four']]);
});

test('.env: a URL-shaped key that is not a database URL is not a candidate', () => {
  const found = findConnectionCandidates([{ path: '.env', text: 'DB_URL=https://example.com\n' }]);
  assert.deepEqual(found, []);
});

// ---------------------------------------------------------------------------
// dispatch, ordering, and the whole-result leak assertion
// ---------------------------------------------------------------------------

test('kindOfFile / looksLikeConnectionFile dispatch on the file name', () => {
  assert.equal(kindOfFile('a/application.yml'), 'spring-yml');
  assert.equal(kindOfFile('a/application.yaml'), 'spring-yml');
  assert.equal(kindOfFile('a/application.properties'), 'spring-properties');
  assert.equal(kindOfFile('a/.env'), 'dotenv');
  assert.equal(kindOfFile('a/local.env'), 'dotenv');
  assert.equal(kindOfFile('a/DataSourceConfig.java'), 'jdbc-url');
  assert.equal(looksLikeConnectionFile('a/DataSourceConfig.java'), false);
  assert.equal(looksLikeConnectionFile('a/application.yml'), true);
});

test('a bare JDBC URL in a Java DataSource bean is found as kind jdbc-url', () => {
  const text = `package com.example.config;
public class DataSourceConfig {
  private static final String URL = "jdbc:mysql://db.example.com:3306/shop?useSSL=false";
}
`;
  const found = findConnectionCandidates([{ path: 'DataSourceConfig.java', text }]);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'jdbc-url');
  assert.equal(found[0].host, 'db.example.com');
  assert.equal(found[0].passwordPresent, false,
    'a password on some neighbouring line cannot be attributed, so it is not claimed');
});

test('candidates come back sorted by path, so two runs print the same list', () => {
  const files = [
    { path: 'z/application.yml', text: 'spring:\n  datasource:\n    url: jdbc:mysql://z.example.com/db\n' },
    { path: 'a/application.yml', text: 'spring:\n  datasource:\n    url: jdbc:mysql://a.example.com/db\n' },
  ];
  const one = findConnectionCandidates(files);
  const two = findConnectionCandidates([...files].reverse());
  assert.deepEqual(one, two);
  assert.deepEqual(one.map((c) => c.path), ['a/application.yml', 'z/application.yml']);
});

test('THE LEAK ASSERTION: no password literal survives into any result, from any format', () => {
  const files = [
    { path: 'application.yml', text: SPRING_YML },
    { path: 'application.properties', text: SPRING_PROPERTIES },
    { path: '.env', text: `JDBC_URL=jdbc:mysql://db.example.com/shop\nDB_PASSWORD=${SECRET}\n` },
    { path: 'inline.java', text: `String u = "jdbc:mysql://app:${SECRET}@db.example.com:3306/shop";` },
  ];
  const diagnostics = [];
  const found = findConnectionCandidates(files, diagnostics);
  assert.equal(found.length, 4);
  noSecret(found, 'the candidate list');
  noSecret(diagnostics, 'the diagnostics');
  for (const c of found) {
    assert.equal(c.passwordPresent, true, `${c.path} should have found a password`);
    assert.equal(c.passwordRef, PASSWORD_LITERAL_REF);
  }
});

test('the exported candidate shape is exactly the documented one', () => {
  const found = findConnectionCandidates([{ path: 'application.yml', text: SPRING_YML }]);
  assert.deepEqual(Object.keys(found[0]).sort(), [
    'database', 'dialect', 'host', 'kind', 'passwordPresent', 'passwordRef',
    'path', 'port', 'url', 'usernameRef',
  ]);
});
