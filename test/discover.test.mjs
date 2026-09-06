import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { discover, prefixOf, coveringPrefixes, minimalRoots, sourceRootOf, isTestPath, classifyDdlFile, ddlDialectFromPath, DiscoverError, SKIP_DIRS } from '../src/core/discover.mjs';

// A synthetic tree in a tmp dir: { 'rel/path': 'contents' }. Directories named
// `.git` are created empty — the walk only needs their presence.
function tree(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-discover-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (content === null) fs.mkdirSync(abs, { recursive: true });
    else fs.writeFileSync(abs, content, 'utf8');
  }
  return root;
}

const SHA = (c) => c.repeat(40).slice(0, 40);

// Real fs for reads, an injected git so no test needs a repository.
function io(heads, extra = {}) {
  return {
    readDir: (dir) => fs.readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, isDir: e.isDirectory(), isFile: e.isFile() })),
    readFile: (file) => fs.readFileSync(file, 'utf8'),
    gitHead: (dir) => heads(dir),
    ...extra,
  };
}

const JAVA_CONTROLLER = `package com.example.web;
import org.springframework.web.bind.annotation.RestController;
@RestController
public class UserController {
  @GetMapping("/users") public String list() { return "x"; }
}
`;
const JAVA_SERVICE = `package com.example.svc;
public class UserService { public String list() { return "x"; } }
`;
const JAVA_ENTITY = `package com.example.domain;
@Entity
public class User { }
`;
const MAPPER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<mapper namespace="com.example.web.UserMapper">
  <select id="list">select id from users</select>
</mapper>
`;
const DDL_MYSQL = 'CREATE TABLE `users` (`id` bigint NOT NULL) ENGINE=InnoDB;\n';
const DDL_PLAIN = 'create table orders (id bigint not null);\n';

test('an OpenAPI / Swagger document is discovered by its top-level key, in JSON and in YAML', (t) => {
  const root = tree(t, {
    '.git/HEAD': 'ref: refs/heads/main\n',
    'api/openapi.yaml': 'openapi: 3.0.1\ninfo:\n  title: x\npaths: {}\n',
    'api/legacy.json': '{ "swagger": "2.0", "basePath": "/v1", "paths": {} }\n',
    'api/nameless.yml': 'openapi: "3.1.0"\npaths: {}\n',
    // Not documents: a package.json, an ordinary config, and a file that only
    // MENTIONS the word deeper down than the head this rule reads.
    'package.json': '{ "name": "x", "dependencies": { "vue": "3.0.0" } }\n',
    'tsconfig.json': '{ "compilerOptions": {} }\n',
    'notes/mentions.yaml': `${'# padding\n'.repeat(600)}openapi: 3.0.0\n`,
    // A Spring Boot config with a `swagger:` block is not a contract, and
    // litemall really ships one: it says `swagger`, declares no version, and has
    // no `paths` section.
    'src/main/resources/application.yml': 'logging:\n  config: classpath:logback.xml\n\nswagger:\n  production: false\n',
    // ...but a document that names no version and DOES declare paths is one.
    'api/versionless.yaml': 'swagger:\npaths:\n  /a:\n    get: {}\n',
  });
  const d = discover(root, io(() => SHA('a')));
  assert.deepEqual(d.openapiDocuments, [
    { path: 'api/legacy.json', version: '2' },
    { path: 'api/nameless.yml', version: '3' },
    { path: 'api/openapi.yaml', version: '3' },
    { path: 'api/versionless.yaml', version: 'unknown' },
  ], 'sorted by path, and only the files whose HEAD declares the key');
});

test('an OpenAPI document over the size cap is reported, never silently read', (t) => {
  const root = tree(t, {
    '.git/HEAD': 'ref: refs/heads/main\n',
    'api/huge.json': `{ "openapi": "3.0.0", "x": "${'p'.repeat(2 * 1024 * 1024 + 10)}" }`,
  });
  const d = discover(root, io(() => SHA('a')));
  assert.deepEqual(d.openapiDocuments, []);
  const said = d.diagnostics.find((x) => x.path === 'api/huge.json');
  assert.ok(said, `no diagnostic for the oversized document: ${JSON.stringify(d.diagnostics)}`);
  assert.match(said.reason, /over the 2 MB this engine reads/);
});

test('discover collects datasource connection candidates, redacted (SPEC §12.1)', (t) => {
  const secret = 'pw-DISCOVER-77';
  const root = tree(t, {
    '.git/HEAD': 'ref: refs/heads/main\n',
    'src/main/java/com/example/svc/UserService.java': JAVA_SERVICE,
    'src/main/resources/application.yml': `spring:
  datasource:
    url: jdbc:mysql://db.example.com:3306/shop
    username: shop_app
    password: ${secret}
`,
    'src/main/resources/application-prod.properties':
      'spring.datasource.url=jdbc:postgresql://pg.example.com:5432/shop\n'
      + 'spring.datasource.username=reader\n',
    'docker-compose.yml': 'services:\n  db:\n    image: mysql:8\n',
  });
  const d = discover(root, io(() => SHA('a')));

  assert.deepEqual(d.connectionCandidates.map((c) => [c.kind, c.host, c.dialect]), [
    ['spring-properties', 'pg.example.com', 'postgres'],
    ['spring-yml', 'db.example.com', 'mysql'],
  ], 'sorted by path; docker-compose.yml names no datasource');
  const yml = d.connectionCandidates.find((c) => c.kind === 'spring-yml');
  assert.equal(yml.usernameRef, 'shop_app');
  assert.equal(yml.passwordPresent, true);
  assert.equal(yml.passwordRef, '<literal in file>');
  // The whole discovery result, not just the field the reader expects.
  assert.equal(JSON.stringify(d).includes(secret), false,
    'discovery must not carry a password value anywhere');
});

test('discover finds the root repo, counts technologies and infers the build tool', (t) => {
  const root = tree(t, {
    '.git/HEAD': 'ref: refs/heads/main\n',
    'pom.xml': '<project/>',
    'src/main/java/com/example/web/UserController.java': JAVA_CONTROLLER,
    'src/main/java/com/example/svc/UserService.java': JAVA_SERVICE,
    'src/main/resources/mapper/UserMapper.xml': MAPPER_XML,
    'src/main/resources/spring.xml': '<beans/>',
    'db/schema.sql': DDL_MYSQL,
    'README.md': '# demo',
  });
  const d = discover(root, io(() => SHA('a')));

  assert.deepEqual(d.repos.map((r) => r.path), ['.']);
  assert.equal(d.repos[0].commit, SHA('a'));
  assert.equal(d.counts.javaFiles, 2);
  assert.equal(d.counts.springHandlerFiles, 1);
  assert.equal(d.counts.mybatisMapperXml, 1);
  assert.equal(d.counts.ddlFiles, 1);
  assert.equal(d.counts.jpaEntityFiles, 0);
  assert.equal(d.counts.kotlinFiles, 0);
  assert.equal(d.counts.frontendPackageJson, 0);
  assert.equal(d.buildTool, 'maven');
  assert.deepEqual(d.ddlPaths, ['db/schema.sql']);
  assert.equal(d.ddlDialectHint, 'mysql');
  assert.equal(d.capped, false);
  assert.deepEqual(d.diagnostics, []);
});

test('discover reports gradle when there is no pom, and null when neither is present', (t) => {
  const g = tree(t, { '.git/HEAD': 'x', 'build.gradle.kts': 'plugins {}', 'a.txt': 'a' });
  assert.equal(discover(g, io(() => SHA('b'))).buildTool, 'gradle');

  const n = tree(t, { '.git/HEAD': 'x', 'a.txt': 'a' });
  assert.equal(discover(n, io(() => SHA('b'))).buildTool, null);
});

test('discover lists nested repositories separately, sorted, with their own commits', (t) => {
  const root = tree(t, {
    '.git/HEAD': 'x',
    'web/.git/HEAD': 'x',
    'web/package.json': JSON.stringify({ dependencies: { react: '18.0.0' } }),
    'api/.git/HEAD': 'x',
    'api/src/A.java': JAVA_SERVICE,
  });
  const heads = (dir) => (dir.endsWith('/web') ? SHA('c') : dir.endsWith('/api') ? SHA('d') : SHA('e'));
  const d = discover(root, io(heads));

  assert.deepEqual(d.repos.map((r) => r.path), ['.', 'api', 'web']);
  assert.deepEqual(d.repos.map((r) => r.commit), [SHA('e'), SHA('d'), SHA('c')]);
  // Files are attributed to the deepest enclosing repository.
  assert.equal(d.repos.find((r) => r.path === 'api').javaFiles, 1);
  assert.equal(d.repos.find((r) => r.path === 'web').frontendPackageJson, 1);
  assert.equal(d.repos.find((r) => r.path === '.').javaFiles, 0);
});

test('discover excludes a repository with no HEAD and says so in a diagnostic', (t) => {
  const root = tree(t, { '.git/HEAD': 'x', 'empty/.git/HEAD': 'x', 'empty/a.txt': 'a' });
  const d = discover(root, io((dir) => (dir.endsWith('/empty') ? null : SHA('f'))));

  assert.deepEqual(d.repos.map((r) => r.path), ['.']);
  const diag = d.diagnostics.find((x) => x.kind === 'REPOSITORY_WITHOUT_HEAD');
  assert.ok(diag, 'expected a REPOSITORY_WITHOUT_HEAD diagnostic');
  assert.equal(diag.path, 'empty');
  assert.match(diag.reason, /HEAD/);
});

test('discover skips the vendored/build directories entirely', (t) => {
  const root = tree(t, {
    '.git/HEAD': 'x',
    'node_modules/pkg/index.java': JAVA_SERVICE,
    'target/classes/Gen.java': JAVA_SERVICE,
    'build/Gen.java': JAVA_SERVICE,
    '.cascade/pack/pack.json': '{}',
    'src/A.java': JAVA_SERVICE,
  });
  const d = discover(root, io(() => SHA('a')));
  assert.equal(d.counts.javaFiles, 1);
  for (const skipped of ['node_modules', 'target', 'build', '.cascade']) {
    assert.ok(SKIP_DIRS.includes(skipped));
  }
});

test('discover raises UNSUPPORTED_TECHNOLOGY for kotlin — but not for a JPA entity or a frontend package, which now have lanes', (t) => {
  const root = tree(t, {
    '.git/HEAD': 'x',
    'app/Main.kt': 'package com.example\nfun main() {}\n',
    'web/package.json': JSON.stringify({ dependencies: { vue: '3.0.0' } }),
    'src/User.java': JAVA_ENTITY,
  });
  const d = discover(root, io(() => SHA('a')));

  assert.equal(d.counts.kotlinFiles, 1);
  assert.equal(d.counts.frontendPackageJson, 1);
  assert.equal(d.counts.jpaEntityFiles, 1);
  const unsupported = d.diagnostics.filter((x) => x.kind === 'UNSUPPORTED_TECHNOLOGY');
  // The @Entity file is COUNTED (that is what makes `init` declare the jpa pack)
  // but it is no longer an uncovered technology — M10 ships its lane. Neither is
  // the frontend package: RM26 ships the web lane that reads it.
  assert.equal(unsupported.length, 1, JSON.stringify(unsupported, null, 2));
  assert.deepEqual(unsupported.map((x) => x.path), ['app/Main.kt']);
  for (const u of unsupported) assert.equal(u.severity, 'info');
});

test('discover measures the web lane\'s inputs: files, .vue files, source roots and what each package declares', (t) => {
  const root = tree(t, {
    '.git/HEAD': 'x',
    'web/package.json': JSON.stringify({ dependencies: { vue: '3.0.0', 'vue-router': '4.0.0', axios: '1.0.0' } }),
    'web/src/main.ts': 'export const a = 1\n',
    'web/src/views/Home.vue': '<template><div/></template>\n<script>export default {}</script>\n',
    'web/src/types/x.d.ts': 'export type X = string\n',
    'web/src/x.test.ts': 'test("x", () => {})\n',
    'ui/package.json': JSON.stringify({ dependencies: { react: '18.0.0', 'react-router-dom': '6.0.0' } }),
    'ui/App.tsx': 'export default function App() { return null }\n',
  });
  const d = discover(root, io(() => SHA('a')));

  // The `.d.ts` and the `.test.ts` are not sources the lane reads, so they are
  // not counted as ones it will.
  assert.equal(d.counts.webFiles, 3, JSON.stringify(d.counts));
  assert.equal(d.counts.vueFiles, 1);
  // `<pkg>/src` when it exists, the package directory itself when it does not.
  assert.deepEqual(d.webSourceRoots, ['ui', 'web/src']);
  assert.deepEqual(d.webPackages, [
    { path: 'ui/package.json', root: 'ui', framework: 'react', router: 'react-router', http: ['fetch-only'] },
    { path: 'web/package.json', root: 'web/src', framework: 'vue', router: 'vue-router', http: ['axios'] },
  ]);
});

test('a frontend package with no router and no axios still gets a record, with what it does declare', (t) => {
  const root = tree(t, {
    '.git/HEAD': 'x',
    'app/package.json': JSON.stringify({ dependencies: { svelte: '4.0.0' } }),
    'app/src/main.js': 'fetch("/x")\n',
  });
  const d = discover(root, io(() => SHA('a')));
  assert.deepEqual(d.webPackages, [
    { path: 'app/package.json', root: 'app/src', framework: 'svelte', router: null, http: ['fetch-only'] },
  ]);
  // Svelte is not an uncovered technology either: the lane reads its files.
  assert.deepEqual(d.diagnostics.filter((x) => x.kind === 'UNSUPPORTED_TECHNOLOGY'), []);
});

test('discover ignores a package.json with no frontend framework dependency', (t) => {
  const root = tree(t, {
    '.git/HEAD': 'x',
    'tools/package.json': JSON.stringify({ dependencies: { lodash: '4.0.0' } }),
  });
  const d = discover(root, io(() => SHA('a')));
  assert.equal(d.counts.frontendPackageJson, 0);
  assert.deepEqual(d.diagnostics, []);
});

test('discover counts DDL only for .sql files that CREATE TABLE, and hints mysql on backticks', (t) => {
  const root = tree(t, {
    '.git/HEAD': 'x',
    'db/one.sql': DDL_PLAIN,
    'db/two.sql': 'select 1;\n',
  });
  const d = discover(root, io(() => SHA('a')));
  assert.equal(d.counts.ddlFiles, 1);
  assert.deepEqual(d.ddlPaths, ['db/one.sql']);
  assert.equal(d.ddlDialectHint, null, 'plain DDL gives no dialect hint');
});

test('discover caps the walk and says the result is partial', (t) => {
  const files = { '.git/HEAD': 'x' };
  for (let i = 0; i < 12; i += 1) files[`src/F${i}.java`] = JAVA_SERVICE;
  const root = tree(t, files);
  const d = discover(root, { ...io(() => SHA('a')), maxFiles: 5 });

  assert.equal(d.capped, true);
  assert.equal(d.filesScanned, 5);
  assert.ok(d.counts.javaFiles <= 5);
  const diag = d.diagnostics.find((x) => x.kind === 'FILE_CAP_REACHED');
  assert.ok(diag, 'expected a FILE_CAP_REACHED diagnostic');
  assert.match(diag.reason, /5 files/);
});

test('discover reports the minimal package prefixes covering 95% of java files', (t) => {
  const files = { '.git/HEAD': 'x' };
  // 19 files in com.example.app, 1 in com.example.legacy -> 19/20 = 95%, one prefix.
  for (let i = 0; i < 19; i += 1) files[`src/app/F${i}.java`] = `package com.example.app.sub;\nclass F${i} {}\n`;
  files['src/legacy/L.java'] = 'package com.example.legacy.old;\nclass L {}\n';
  const root = tree(t, files);
  const d = discover(root, io(() => SHA('a')));
  assert.deepEqual(d.packagePrefixes, ['com.example.app']);
});

test('discover keeps a second prefix when one does not reach the coverage threshold', (t) => {
  const files = { '.git/HEAD': 'x' };
  for (let i = 0; i < 6; i += 1) files[`src/a/F${i}.java`] = `package com.example.alpha;\nclass F${i} {}\n`;
  for (let i = 0; i < 4; i += 1) files[`src/b/G${i}.java`] = `package com.example.beta;\nclass G${i} {}\n`;
  const root = tree(t, files);
  const d = discover(root, io(() => SHA('a')));
  assert.deepEqual(d.packagePrefixes, ['com.example.alpha', 'com.example.beta']);
});

test('discover reports no package prefixes when there is no java', (t) => {
  const root = tree(t, { '.git/HEAD': 'x', 'db/one.sql': DDL_PLAIN });
  assert.deepEqual(discover(root, io(() => SHA('a'))).packagePrefixes, []);
});

test('discover turns an unreadable file into a diagnostic, not a crash', (t) => {
  const root = tree(t, { '.git/HEAD': 'x', 'src/A.java': JAVA_SERVICE });
  const bad = {
    ...io(() => SHA('a')),
    readFile: (f) => { throw new Error('permission denied'); },
  };
  const d = discover(root, bad);
  assert.equal(d.counts.javaFiles, 1);
  const diag = d.diagnostics.find((x) => x.kind === 'UNREADABLE_FILE');
  assert.ok(diag);
  assert.match(diag.reason, /permission denied/);
});

test('discover rejects a missing root or missing injected io', (t) => {
  const root = tree(t, { '.git/HEAD': 'x' });
  assert.throws(() => discover('', io(() => SHA('a'))), DiscoverError);
  assert.throws(() => discover(root, {}), DiscoverError);
  assert.throws(() => discover(root, { readDir: () => [], readFile: () => '' }), /gitHead/);
});

test('prefixOf takes three segments, or the whole package when shorter', () => {
  assert.equal(prefixOf('com.example.app.web.user'), 'com.example.app');
  assert.equal(prefixOf('com.example'), 'com.example');
  assert.equal(prefixOf('single'), 'single');
});

test('coveringPrefixes is empty without java and greedy-minimal otherwise', () => {
  assert.deepEqual(coveringPrefixes(new Map(), 0), []);
  assert.deepEqual(coveringPrefixes(new Map([['a.b.c', 10]]), 10), ['a.b.c']);
  // 10 + 1: the big one alone covers 10/11 = 90.9% < 95%, so both are reported.
  assert.deepEqual(coveringPrefixes(new Map([['a.b.c', 10], ['d.e.f', 1]]), 11), ['a.b.c', 'd.e.f']);
});

// ---------------------------------------------------------------------------
// The lane inputs a no-flag `cascade analyze` runs over (round RM2)
// ---------------------------------------------------------------------------

test('discover reports the mapper directories and the java source roots it measured', (t) => {
  const root = tree(t, {
    '.git/HEAD': 'ref: refs/heads/main\n',
    'pom.xml': '<project/>',
    'admin/src/main/java/com/example/web/UserController.java': JAVA_CONTROLLER,
    'admin/src/main/java/com/example/svc/UserService.java': JAVA_SERVICE,
    'admin/src/main/resources/dao/UserMapper.xml': MAPPER_XML,
    'mbg/src/main/java/com/example/svc/OtherService.java': JAVA_SERVICE,
    'mbg/src/main/resources/com/example/mapper/OtherMapper.xml': MAPPER_XML,
    'mbg/src/main/resources/not-a-mapper.xml': '<beans/>',
  });
  const d = discover(root, io(() => SHA('a')));
  // The root is measured from the file's own `package`, not assumed to be
  // src/main/java — the two modules come out as two roots.
  assert.deepEqual(d.javaSourceRoots, ['admin/src/main/java', 'mbg/src/main/java']);
  assert.deepEqual(d.javaTestRoots, []);
  // Only directories that really hold a <mapper namespace=…> file.
  assert.deepEqual(d.mapperDirs, ['admin/src/main/resources/dao', 'mbg/src/main/resources/com/example/mapper']);
  assert.equal(d.counts.mybatisMapperXml, 2);
});

test('discover: a java file whose directory disagrees with its package keeps its own directory', (t) => {
  const root = tree(t, {
    '.git/HEAD': 'x',
    'loose/Misplaced.java': 'package com.example.web;\npublic class Misplaced { }\n',
    'nopkg/Plain.java': 'public class Plain { }\n',
  });
  const d = discover(root, io(() => SHA('a')));
  // Neither is climbed: `loose/` does not end with com/example/web, and
  // `nopkg/Plain.java` declares no package at all.
  assert.deepEqual(d.javaSourceRoots, ['loose', 'nopkg']);
});

test('discover: a mapper directory nested under another is dropped (a file is not analyzed twice)', (t) => {
  const root = tree(t, {
    '.git/HEAD': 'x',
    'res/A.xml': MAPPER_XML,
    'res/sub/B.xml': MAPPER_XML,
    'src/main/java/com/example/web/UserController.java': JAVA_CONTROLLER,
  });
  const d = discover(root, io(() => SHA('a')));
  assert.deepEqual(d.mapperDirs, ['res'], 'res/sub is walked by --mappers res already');
  assert.deepEqual(d.javaSourceRoots, ['src/main/java']);
});

test('minimalRoots / sourceRootOf are pure and handle the root-relative "." case', () => {
  assert.deepEqual(minimalRoots(['a', 'a/b', 'c', 'a']), ['a', 'c']);
  assert.deepEqual(minimalRoots(['.', 'a/b']), ['.'], 'the scan root swallows everything below it');
  assert.deepEqual(minimalRoots([]), []);
  assert.equal(sourceRootOf('/r/src/main/java/com/example', 'com.example', '/r'), '/r/src/main/java');
  assert.equal(sourceRootOf('/r/loose', 'com.example', '/r'), '/r/loose');
  // Never climbs above the scanned tree, whatever the package claims.
  assert.equal(sourceRootOf('/r/com/example', 'a.b.c.d.e', '/r'), '/r/com/example');
});

test('isTestPath: the standard src/test layout, and nothing that merely says "test"', () => {
  assert.equal(isTestPath('src/test'), true);
  assert.equal(isTestPath('src/test/java'), true);
  assert.equal(isTestPath('app/src/test/java'), true);
  assert.equal(isTestPath('modules/x/src/test'), true);
  assert.equal(isTestPath('src/main/java'), false);
  // A package or class NAMED test is production code and must not be excluded.
  assert.equal(isTestPath('src/main/java/com/example/testing'), false);
  assert.equal(isTestPath('src/main/java/com/example/test'), false);
  assert.equal(isTestPath('testsupport/src/main/java'), false);
  assert.equal(isTestPath(''), false);
});

test('discover splits test roots out of the main ones and counts their files separately', (t) => {
  const root = tree(t, {
    '.git/HEAD': 'x',
    'app/src/main/java/com/example/web/UserController.java': JAVA_CONTROLLER,
    'app/src/test/java/com/example/web/UserControllerTest.java': JAVA_SERVICE.replace('svc', 'web'),
    // mall-style: a test tree with no `java` segment (package starts right under src/test).
    'other/src/test/com/example/svc/UserServiceTest.java': JAVA_SERVICE,
  });
  const d = discover(root, io(() => SHA('a')));
  assert.deepEqual(d.javaSourceRoots, ['app/src/main/java']);
  assert.deepEqual(d.javaTestRoots, ['app/src/test/java', 'other/src/test']);
  // Nothing is hidden: the files are still in the total, and counted on their own.
  assert.equal(d.counts.javaFiles, 3);
  assert.equal(d.counts.javaTestFiles, 2);
});

// ---------------------------------------------------------------------------
// WHAT A .sql FILE IS (RM20 §3) — dialect and role, from the text and the path.
// ---------------------------------------------------------------------------

test('classifyDdlFile: the PATH names the dialect, and it beats what the text looks like', () => {
  // An H2 file written in H2's MySQL compatibility mode is full of backticks, so
  // its TEXT says mysql while its NAME says h2. Believing the text applies the
  // same 64 tables twice; believing the name gets it right.
  const mysqlLooking = 'CREATE TABLE `t` (`id` int) ENGINE=InnoDB;';
  assert.equal(classifyDdlFile('sql/schema_h2.sql', mysqlLooking).dialect, 'h2');
  assert.equal(classifyDdlFile('sql/schema_h2.sql', mysqlLooking).dialectFrom, 'path');
  assert.equal(classifyDdlFile('sql/schema_mysql.sql', mysqlLooking).dialect, 'mysql');
  assert.equal(classifyDdlFile('db/hsqldb/schema.sql', mysqlLooking).dialect, 'hsqldb');
  assert.equal(classifyDdlFile('db/postgresql/schema.sql', mysqlLooking).dialect, 'postgres');
  assert.equal(classifyDdlFile('db/x.sql', mysqlLooking).dialectFrom, 'content');
});

test('ddlDialectFromPath: whole tokens only — a name that merely contains one is not a match', () => {
  assert.equal(ddlDialectFromPath('sql/mysql_init.sql'), 'mysql');
  assert.equal(ddlDialectFromPath('db/mysql/schema.sql'), 'mysql');
  assert.equal(ddlDialectFromPath('sql/dolphinscheduler_postgresql.sql'), 'postgres');
  assert.equal(ddlDialectFromPath('notes/pgadmin-export.sql'), null, '"pg" inside a word is not a dialect');
  assert.equal(ddlDialectFromPath('db/schema.sql'), null);
});

test('classifyDdlFile: with no dialect in the path, spellings only that dialect has decide', () => {
  const d = (text, p = 'db/x.sql') => classifyDdlFile(p, text).dialect;
  assert.equal(d('CREATE TABLE `t` (`id` int) ENGINE=InnoDB;'), 'mysql');
  assert.equal(d('CREATE TABLE t (id SERIAL PRIMARY KEY);'), 'postgres');
  assert.equal(d('ALTER TABLE t OWNER TO postgres;'), 'postgres');
  assert.equal(d('CREATE TABLE t (id NUMBER(19), name VARCHAR2(64));'), 'oracle');
  assert.equal(d('CREATE CACHED TABLE t (id INTEGER);'), 'h2');
  assert.equal(d('CREATE TABLE t (id INTEGER GENERATED BY DEFAULT AS IDENTITY);'), 'h2');
  // Nothing distinctive: a portable dump names no dialect, and the classifier
  // says so instead of picking one.
  assert.equal(d('CREATE TABLE t (id INTEGER, name VARCHAR(30));'), null);
});

test('classifyDdlFile: the role is schema when it DECLARES, migration when it CHANGES', () => {
  const r = (text, p = 'db/x.sql') => classifyDdlFile(p, text).role;
  assert.equal(r('CREATE TABLE a (id int);\nCREATE TABLE b (id int);'), 'schema');
  assert.equal(r('ALTER TABLE a ADD COLUMN x int;\nALTER TABLE b ADD COLUMN y int;'), 'migration');
  assert.equal(r("INSERT INTO a VALUES (1);\nUPDATE a SET x = 1;"), 'migration');
  // A SCHEMA DUMP THAT ALSO SEEDS ROWS is still the schema. Most projects ship
  // exactly one file and it ends with hundreds of INSERTs; the catalog reader
  // never looks at an INSERT, so seed data cannot make a file a migration.
  assert.equal(r(`${'CREATE TABLE a (id int);\n'.repeat(20)}${'INSERT INTO a VALUES (1);\n'.repeat(250)}`), 'schema');
  // …but a file that declares four tables and ALTERs sixteen is amending more
  // than it declares, and is one.
  assert.equal(r(`${'CREATE TABLE a (id int);\n'.repeat(4)}${'ALTER TABLE b ADD COLUMN x int;\n'.repeat(16)}`), 'migration');
  // A CREATE-TABLE-only file under a migration directory is STILL a migration:
  // the tool that owns that directory decides what order it runs in, and that
  // order is not this engine's to invent.
  assert.equal(r('CREATE TABLE a (id int);', 'src/main/resources/db/migration/V1__init.sql'), 'migration');
  assert.equal(r('CREATE TABLE a (id int);', 'sql/upgrade/3.0.0_schema.sql'), 'migration');
  assert.equal(r('CREATE TABLE a (id int);', 'db/liquibase/changelog.sql'), 'migration');
});

test('classifyDdlFile: the counts it decided on ride along, so the decision can be checked', () => {
  const c = classifyDdlFile('db/x.sql', 'CREATE TABLE a (id int);\nALTER TABLE a ADD COLUMN x int;\nINSERT INTO a VALUES (1);');
  assert.equal(c.createTables, 1);
  assert.equal(c.alters, 1);
  assert.equal(c.dml, 1);
  assert.equal(c.role, 'schema', 'one CREATE and one ALTER declares as much as it changes');
  assert.equal(c.byPath, false);
  assert.equal(c.testPath, false);
});

test('classifyDdlFile: a .sql under src/test is marked as such — the same layout rule the Java lane uses', () => {
  const schema = 'CREATE TABLE a (id int);';
  assert.equal(classifyDdlFile('module/src/test/resources/schema/full.sql', schema).testPath, true);
  assert.equal(classifyDdlFile('src/main/resources/db/schema.sql', schema).testPath, false);
});

test('discover: every .sql that declares OR amends a table is a classified candidate', (t) => {
  const root = tree(t, {
    '.git/HEAD': 'x',
    'svc-a/db/mysql/schema.sql': 'CREATE TABLE `owners` (`id` int) ENGINE=InnoDB;',
    'svc-b/db/mysql/schema.sql': 'CREATE TABLE `vets` (`id` int) ENGINE=InnoDB;',
    'db/postgres/schema.sql': 'CREATE TABLE owners (id SERIAL);',
    'db/migration/V2__add.sql': 'ALTER TABLE owners ADD COLUMN city varchar(30);',
    'db/notes.sql': 'SELECT 1;',
  });
  const d = discover(root, io(() => SHA('a')));
  assert.deepEqual(d.ddlCandidates.map((c) => [c.path, c.role, c.dialect, c.dialectFrom]), [
    ['db/migration/V2__add.sql', 'migration', null, null],
    ['db/postgres/schema.sql', 'schema', 'postgres', 'path'],
    ['svc-a/db/mysql/schema.sql', 'schema', 'mysql', 'path'],
    ['svc-b/db/mysql/schema.sql', 'schema', 'mysql', 'path'],
  ]);
  // A .sql with neither is not a candidate at all, and `ddlPaths`/`ddlFiles`
  // keep their old meaning (CREATE TABLE only), so nothing that read them moved.
  assert.equal(d.counts.ddlFiles, 3);
  assert.deepEqual(d.ddlPaths, ['db/postgres/schema.sql', 'svc-a/db/mysql/schema.sql', 'svc-b/db/mysql/schema.sql']);
});
