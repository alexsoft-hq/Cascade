// nest_routes.test.mjs — nestRoutes: which routes a NestJS application serves, from hand-written tsfacts records.
//
// A route is not made from a decorator alone: the application has to be found
// (the create whose holder then calls listen), its module graph walked from
// there, and its global prefix and versioning read as literals. What cannot be
// read that way makes no route, and says why. Every fixture below is a small,
// self-contained TypeScript project, in the style of test/rules.test.mjs and
// test/web_bridge.test.mjs: hand-written records, not a real repository.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { factsOfFile } from '../adapters/ts/tsfacts.mjs';
import { readProject } from '../src/adapters/ts/project.mjs';
import { nestRoutes } from '../src/adapters/ts/nest_routes.mjs';
import { builtinRegistry } from '../src/core/rules/registry.mjs';

const ROUTE_RULE = builtinRegistry().ofKind('ts.route-decorator')[0].compiled;

/** Every file's tsfacts records, concatenated: the bridge reads a whole project at once. */
function recordsOf(files) {
  return files.flatMap(([name, source]) => factsOfFile(name, source));
}

function routesOf(files, declared = {}, tsconfig = {}) {
  const project = readProject(recordsOf(files), tsconfig);
  return nestRoutes(project, ROUTE_RULE, declared);
}

const kindsOf = (diagnostics) => diagnostics.map((d) => d.kind);
const pathsOf = (routes) => routes.map((r) => `${r.verb} ${r.path}`).sort();

/** A controller file with one GET route, so a fixture can name a module's controller without repeating boilerplate. */
const controllerFile = (fileBase, className, routePath) => [`${fileBase}.ts`, [
  "import { Controller, Get } from '@nestjs/common';",
  `@Controller('${routePath}')`,
  `export class ${className} {`,
  '  @Get() list() {}',
  '}',
].join('\n')];

// ---------------------------------------------------------------------------
// which application is served
// ---------------------------------------------------------------------------

test('the served application is the create whose holder then calls listen; a create that only closes is not it', () => {
  const main = ['main.ts', [
    "import { NestFactory } from '@nestjs/core';",
    "import { AppModule } from './app.module';",
    "import { OtherModule } from './other.module';",
    'async function bootstrap() {',
    '  const temp = await NestFactory.create(OtherModule);',
    '  await temp.close();',
    '  const app = await NestFactory.create(AppModule);',
    '  await app.listen(3000);',
    '}',
    'bootstrap();',
  ].join('\n')];
  const appModule = ['app.module.ts', [
    "import { Module } from '@nestjs/common';",
    "import { AppController } from './app.controller';",
    '@Module({ controllers: [AppController] })',
    'export class AppModule {}',
  ].join('\n')];
  const otherModule = ['other.module.ts', [
    "import { Module } from '@nestjs/common';",
    "import { OtherController } from './other.controller';",
    '@Module({ controllers: [OtherController] })',
    'export class OtherModule {}',
  ].join('\n')];
  const appController = controllerFile('app.controller', 'AppController', 'app');
  const otherController = controllerFile('other.controller', 'OtherController', 'other');
  const result = routesOf([main, appModule, otherModule, appController, otherController]);
  assert.deepEqual(pathsOf(result.routes), ['GET /app'], 'only the module of the create that listens is served');
  assert.deepEqual(result.unregistered, ['other.controller.ts#OtherController'], 'the other module is never reached from the root it was never handed to');
});

test('with no call of NestFactory.create at all, no application is found and no route is made', () => {
  const appModule = ['app.module.ts', [
    "import { Module } from '@nestjs/common';",
    "import { AppController } from './app.controller';",
    '@Module({ controllers: [AppController] })',
    'export class AppModule {}',
  ].join('\n')];
  const appController = controllerFile('app.controller', 'AppController', 'app');
  const result = routesOf([appModule, appController]);
  assert.deepEqual(result.routes, []);
  assert.deepEqual(kindsOf(result.diagnostics), ['TS_APP_NOT_FOUND']);
  assert.equal(result.unregistered, null, 'which controllers the application would register was never asked');
});

// ---------------------------------------------------------------------------
// which controllers a module registers
// ---------------------------------------------------------------------------

test('a controller serves routes when a reachable module lists it directly, through X.forRoot(), or through forwardRef(() => X); one no module reaches serves nothing', () => {
  const main = ['main.ts', [
    "import { NestFactory } from '@nestjs/core';",
    "import { AppModule } from './app.module';",
    'async function bootstrap() {',
    '  const app = await NestFactory.create(AppModule);',
    '  await app.listen(3000);',
    '}',
    'bootstrap();',
  ].join('\n')];
  const appModule = ['app.module.ts', [
    "import { Module, forwardRef } from '@nestjs/common';",
    "import { UsersModule } from './users.module';",
    "import { ThingsModule } from './things.module';",
    "import { AdminModule } from './admin.module';",
    '@Module({ imports: [UsersModule, ThingsModule.forRoot(), forwardRef(() => AdminModule)] })',
    'export class AppModule {}',
  ].join('\n')];
  const usersModule = ['users.module.ts', [
    "import { Module } from '@nestjs/common';",
    "import { UsersController } from './users.controller';",
    '@Module({ controllers: [UsersController] })',
    'export class UsersModule {}',
  ].join('\n')];
  const thingsModule = ['things.module.ts', [
    "import { Module } from '@nestjs/common';",
    "import { ThingsController } from './things.controller';",
    '@Module({ controllers: [ThingsController] })',
    'export class ThingsModule {',
    '  static forRoot() { return { module: ThingsModule }; }',
    '}',
  ].join('\n')];
  const adminModule = ['admin.module.ts', [
    "import { Module } from '@nestjs/common';",
    "import { AdminController } from './admin.controller';",
    '@Module({ controllers: [AdminController] })',
    'export class AdminModule {}',
  ].join('\n')];
  const usersController = controllerFile('users.controller', 'UsersController', 'users');
  const thingsController = controllerFile('things.controller', 'ThingsController', 'things');
  const adminController = controllerFile('admin.controller', 'AdminController', 'admin');
  const orphanController = controllerFile('orphan.controller', 'OrphanController', 'orphan');
  const result = routesOf([main, appModule, usersModule, thingsModule, adminModule,
    usersController, thingsController, adminController, orphanController]);
  assert.deepEqual(pathsOf(result.routes), ['GET /admin', 'GET /things', 'GET /users']);
  assert.deepEqual(result.unregistered, ['orphan.controller.ts#OrphanController']);
});

// ---------------------------------------------------------------------------
// prefix and versioning
// ---------------------------------------------------------------------------

test('a global prefix and URI versioning put the prefix and default version before every route, and :id becomes {id}', () => {
  const main = ['main.ts', [
    "import { NestFactory } from '@nestjs/core';",
    "import { VersioningType } from '@nestjs/common';",
    "import { AppModule } from './app.module';",
    'async function bootstrap() {',
    '  const app = await NestFactory.create(AppModule);',
    "  app.setGlobalPrefix('api');",
    "  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });",
    '  await app.listen(3000);',
    '}',
    'bootstrap();',
  ].join('\n')];
  const appModule = ['app.module.ts', [
    "import { Module } from '@nestjs/common';",
    "import { ThingsController } from './things.controller';",
    '@Module({ controllers: [ThingsController] })',
    'export class AppModule {}',
  ].join('\n')];
  const thingsController = ['things.controller.ts', [
    "import { Controller, Get } from '@nestjs/common';",
    "@Controller('things')",
    'export class ThingsController {',
    "  @Get(':id') get() {}",
    '}',
  ].join('\n')];
  const result = routesOf([main, appModule, thingsController]);
  assert.deepEqual(pathsOf(result.routes), ['GET /api/v1/things/{id}']);
});

test('@Version on a method overrides the controller and the default; VERSION_NEUTRAL serves the route under no version', () => {
  const main = ['main.ts', [
    "import { NestFactory } from '@nestjs/core';",
    "import { VersioningType } from '@nestjs/common';",
    "import { AppModule } from './app.module';",
    'async function bootstrap() {',
    '  const app = await NestFactory.create(AppModule);',
    "  app.setGlobalPrefix('api');",
    "  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });",
    '  await app.listen(3000);',
    '}',
    'bootstrap();',
  ].join('\n')];
  const appModule = ['app.module.ts', [
    "import { Module } from '@nestjs/common';",
    "import { DataController } from './data.controller';",
    '@Module({ controllers: [DataController] })',
    'export class AppModule {}',
  ].join('\n')];
  const dataController = ['data.controller.ts', [
    "import { Controller, Get, Version, VERSION_NEUTRAL } from '@nestjs/common';",
    "@Controller('data')",
    'export class DataController {',
    "  @Get('quotes') quotes() {}",
    "  @Version('2') @Get('special') special() {}",
    '  @Version(VERSION_NEUTRAL) @Get(\'health\') health() {}',
    '}',
  ].join('\n')];
  const result = routesOf([main, appModule, dataController]);
  assert.deepEqual(pathsOf(result.routes), [
    'GET /api/data/health',
    'GET /api/v1/data/quotes',
    'GET /api/v2/data/special',
  ]);
});

test('a controller version: [\'1\', \'2\'] gives one route per version', () => {
  const main = ['main.ts', [
    "import { NestFactory } from '@nestjs/core';",
    "import { VersioningType } from '@nestjs/common';",
    "import { AppModule } from './app.module';",
    'async function bootstrap() {',
    '  const app = await NestFactory.create(AppModule);',
    "  app.setGlobalPrefix('api');",
    "  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });",
    '  await app.listen(3000);',
    '}',
    'bootstrap();',
  ].join('\n')];
  const appModule = ['app.module.ts', [
    "import { Module } from '@nestjs/common';",
    "import { ItemsController } from './items.controller';",
    '@Module({ controllers: [ItemsController] })',
    'export class AppModule {}',
  ].join('\n')];
  const itemsController = ['items.controller.ts', [
    "import { Controller, Get } from '@nestjs/common';",
    "@Controller({ path: 'items', version: ['1', '2'] })",
    'export class ItemsController {',
    '  @Get() list() {}',
    '}',
  ].join('\n')];
  const result = routesOf([main, appModule, itemsController]);
  assert.deepEqual(pathsOf(result.routes), ['GET /api/v1/items', 'GET /api/v2/items']);
});

test('a literal plain-path exclude serves that route with no prefix; a pattern or a non-literal entry is only reported', () => {
  const main = ['main.ts', [
    "import { NestFactory } from '@nestjs/core';",
    "import { AppModule } from './app.module';",
    'async function bootstrap() {',
    '  const app = await NestFactory.create(AppModule);',
    "  app.setGlobalPrefix('api', { exclude: ['sitemap.xml', 'health*', dynamicPath] });",
    '  await app.listen(3000);',
    '}',
    'bootstrap();',
  ].join('\n')];
  const appModule = ['app.module.ts', [
    "import { Module } from '@nestjs/common';",
    "import { SiteController } from './site.controller';",
    '@Module({ controllers: [SiteController] })',
    'export class AppModule {}',
  ].join('\n')];
  const siteController = ['site.controller.ts', [
    "import { Controller, Get } from '@nestjs/common';",
    '@Controller()',
    'export class SiteController {',
    "  @Get('sitemap.xml') sitemap() {}",
    "  @Get('list') list() {}",
    '}',
  ].join('\n')];
  const result = routesOf([main, appModule, siteController]);
  assert.deepEqual(pathsOf(result.routes), ['GET /api/list', 'GET /sitemap.xml']);
  const exclude = result.diagnostics.find((d) => d.kind === 'TS_PREFIX_EXCLUDE_UNREAD');
  assert.ok(exclude, 'the pattern and the non-literal entry are said, not silently dropped');
  assert.match(exclude.reason, /excludes 2 route pattern\(s\)/);
  // An exclude this engine cannot read may name /list, so its address is a guess;
  // the one the literal names is sure.
  const grade = Object.fromEntries(result.routes.map((r) => [r.path, r.grade ?? 'EXACT']));
  assert.deepEqual(grade, { '/api/list': 'HEURISTIC', '/sitemap.xml': 'EXACT' });
});

test('a global prefix read from configuration makes no routes and says TS_PREFIX_UNREAD; a declared profile prefix is used instead', () => {
  const main = ['main.ts', [
    "import { NestFactory } from '@nestjs/core';",
    "import { AppModule } from './app.module';",
    'async function bootstrap() {',
    '  const app = await NestFactory.create(AppModule);',
    "  app.setGlobalPrefix(config.get('prefix'));",
    '  await app.listen(3000);',
    '}',
    'bootstrap();',
  ].join('\n')];
  const appModule = ['app.module.ts', [
    "import { Module } from '@nestjs/common';",
    "import { ThingsController } from './things.controller';",
    '@Module({ controllers: [ThingsController] })',
    'export class AppModule {}',
  ].join('\n')];
  const thingsController = controllerFile('things.controller', 'ThingsController', 'things');
  const files = [main, appModule, thingsController];
  const unread = routesOf(files);
  assert.deepEqual(unread.routes, []);
  assert.ok(kindsOf(unread.diagnostics).includes('TS_PREFIX_UNREAD'));
  assert.equal(unread.unregistered, null);
  const declared = routesOf(files, { globalPrefix: 'api' });
  assert.deepEqual(pathsOf(declared.routes), ['GET /api/things']);
  assert.ok(!kindsOf(declared.diagnostics).includes('TS_PREFIX_DECLARED'), 'the bootstrap set nothing literal to disagree with');
});

test('a declared globalPrefix that differs from a literal the bootstrap sets is the one used, and the disagreement is reported', () => {
  const main = ['main.ts', [
    "import { NestFactory } from '@nestjs/core';",
    "import { AppModule } from './app.module';",
    'async function bootstrap() {',
    '  const app = await NestFactory.create(AppModule);',
    "  app.setGlobalPrefix('api');",
    '  await app.listen(3000);',
    '}',
    'bootstrap();',
  ].join('\n')];
  const appModule = ['app.module.ts', [
    "import { Module } from '@nestjs/common';",
    "import { ThingsController } from './things.controller';",
    '@Module({ controllers: [ThingsController] })',
    'export class AppModule {}',
  ].join('\n')];
  const thingsController = controllerFile('things.controller', 'ThingsController', 'things');
  const result = routesOf([main, appModule, thingsController], { globalPrefix: 'v2' });
  assert.deepEqual(pathsOf(result.routes), ['GET /v2/things']);
  assert.ok(kindsOf(result.diagnostics).includes('TS_PREFIX_DECLARED'));
});

test('versioning options not written as literals make no routes and say TS_VERSIONING_UNREAD', () => {
  const main = ['main.ts', [
    "import { NestFactory } from '@nestjs/core';",
    "import { AppModule } from './app.module';",
    'async function bootstrap() {',
    '  const app = await NestFactory.create(AppModule);',
    '  app.enableVersioning(getVersioningConfig());',
    '  await app.listen(3000);',
    '}',
    'bootstrap();',
  ].join('\n')];
  const appModule = ['app.module.ts', [
    "import { Module } from '@nestjs/common';",
    "import { ThingsController } from './things.controller';",
    '@Module({ controllers: [ThingsController] })',
    'export class AppModule {}',
  ].join('\n')];
  const thingsController = controllerFile('things.controller', 'ThingsController', 'things');
  const result = routesOf([main, appModule, thingsController]);
  assert.deepEqual(result.routes, []);
  assert.ok(kindsOf(result.diagnostics).includes('TS_VERSIONING_UNREAD'));
});

// ---------------------------------------------------------------------------
// RouterModule.register
// ---------------------------------------------------------------------------

test('RouterModule.register puts its path before the routes of the module it names, at every depth of children', () => {
  const main = ['main.ts', [
    "import { NestFactory } from '@nestjs/core';",
    "import { AppModule } from './app.module';",
    'async function bootstrap() {',
    '  const app = await NestFactory.create(AppModule);',
    '  await app.listen(3000);',
    '}',
    'bootstrap();',
  ].join('\n')];
  const appModule = ['app.module.ts', [
    "import { Module } from '@nestjs/common';",
    "import { RouterModule } from '@nestjs/core';",
    "import { AdminModule } from './admin.module';",
    "import { ReportsModule } from './reports.module';",
    '@Module({',
    '  imports: [',
    '    AdminModule,',
    '    ReportsModule,',
    '    RouterModule.register([',
    "      { path: 'admin', module: AdminModule, children: [",
    "        { path: 'reports', module: ReportsModule },",
    '      ] },',
    '    ]),',
    '  ],',
    '})',
    'export class AppModule {}',
  ].join('\n')];
  const adminModule = ['admin.module.ts', [
    "import { Module } from '@nestjs/common';",
    "import { AdminController } from './admin.controller';",
    '@Module({ controllers: [AdminController] })',
    'export class AdminModule {}',
  ].join('\n')];
  const reportsModule = ['reports.module.ts', [
    "import { Module } from '@nestjs/common';",
    "import { ReportsController } from './reports.controller';",
    '@Module({ controllers: [ReportsController] })',
    'export class ReportsModule {}',
  ].join('\n')];
  const adminController = controllerFile('admin.controller', 'AdminController', 'items');
  const reportsController = controllerFile('reports.controller', 'ReportsController', 'summary');
  const result = routesOf([main, appModule, adminModule, reportsModule, adminController, reportsController]);
  assert.deepEqual(pathsOf(result.routes), ['GET /admin/items', 'GET /admin/reports/summary']);
});

test('a RouterModule.register argument not written as literals gives TS_ROUTER_MODULE_UNREAD and no routes', () => {
  const main = ['main.ts', [
    "import { NestFactory } from '@nestjs/core';",
    "import { AppModule } from './app.module';",
    'async function bootstrap() {',
    '  const app = await NestFactory.create(AppModule);',
    '  await app.listen(3000);',
    '}',
    'bootstrap();',
  ].join('\n')];
  const appModule = ['app.module.ts', [
    "import { Module } from '@nestjs/common';",
    "import { RouterModule } from '@nestjs/core';",
    "import { AdminModule } from './admin.module';",
    '@Module({ imports: [AdminModule, RouterModule.register(computeRoutes())] })',
    'export class AppModule {}',
  ].join('\n')];
  const adminModule = ['admin.module.ts', [
    "import { Module } from '@nestjs/common';",
    "import { AdminController } from './admin.controller';",
    '@Module({ controllers: [AdminController] })',
    'export class AdminModule {}',
  ].join('\n')];
  const adminController = controllerFile('admin.controller', 'AdminController', 'items');
  const result = routesOf([main, appModule, adminModule, adminController]);
  assert.deepEqual(result.routes, []);
  assert.ok(kindsOf(result.diagnostics).includes('TS_ROUTER_MODULE_UNREAD'));
});

// ---------------------------------------------------------------------------
// module imports the bridge cannot read
// ---------------------------------------------------------------------------

test('a package module needs no diagnostic; a local variable or a spread in imports gives TS_MODULE_IMPORT_UNREAD', () => {
  const main = ['main.ts', [
    "import { NestFactory } from '@nestjs/core';",
    "import { AppModule } from './app.module';",
    'async function bootstrap() {',
    '  const app = await NestFactory.create(AppModule);',
    '  await app.listen(3000);',
    '}',
    'bootstrap();',
  ].join('\n')];
  const appModule = ['app.module.ts', [
    "import { Module } from '@nestjs/common';",
    "import { ConfigModule } from '@nestjs/config';",
    'const flag = true;',
    'const Picked = flag ? ConfigModule : ConfigModule;',
    '@Module({ imports: [ConfigModule, ConfigModule.forRoot(), Picked, ...extraModules] })',
    'export class AppModule {}',
  ].join('\n')];
  const result = routesOf([main, appModule]);
  const unreadImports = result.diagnostics.filter((d) => d.kind === 'TS_MODULE_IMPORT_UNREAD');
  assert.equal(unreadImports.length, 2, unreadImports.map((d) => d.reason).join(' | '));
  assert.ok(unreadImports.some((d) => d.reason.includes('Picked')), 'the local variable is named');
  assert.ok(unreadImports.some((d) => /spread/.test(d.reason)), 'the spread is its own diagnostic');
  assert.ok(!unreadImports.some((d) => d.reason.includes('ConfigModule')), 'a package module is no failure to read this project');
});

// ---------------------------------------------------------------------------
// a route path this engine cannot read
// ---------------------------------------------------------------------------

test('a controller path held in a variable gives TS_ROUTE_PATH_UNREAD and no route for it', () => {
  const main = ['main.ts', [
    "import { NestFactory } from '@nestjs/core';",
    "import { AppModule } from './app.module';",
    'async function bootstrap() {',
    '  const app = await NestFactory.create(AppModule);',
    '  await app.listen(3000);',
    '}',
    'bootstrap();',
  ].join('\n')];
  const appModule = ['app.module.ts', [
    "import { Module } from '@nestjs/common';",
    "import { DynamicController } from './dynamic.controller';",
    '@Module({ controllers: [DynamicController] })',
    'export class AppModule {}',
  ].join('\n')];
  const dynamicController = ['dynamic.controller.ts', [
    "import { Controller, Get } from '@nestjs/common';",
    "const BASE = 'x';",
    '@Controller(BASE)',
    'export class DynamicController {',
    "  @Get('a') a() {}",
    '}',
  ].join('\n')];
  const result = routesOf([main, appModule, dynamicController]);
  assert.deepEqual(result.routes, []);
  assert.ok(kindsOf(result.diagnostics).includes('TS_ROUTE_PATH_UNREAD'));
});

// ---------------------------------------------------------------------------
// what the bootstrap says is read only when it is sure
// ---------------------------------------------------------------------------

/** A bootstrap with the given lines between create and listen, a module listing the controllers, and the files given. */
function appWith(bootLines, controllers, files, { header = [] } = {}) {
  const main = ['main.ts', [
    "import { NestFactory } from '@nestjs/core';",
    "import { RequestMethod } from '@nestjs/common';",
    "import { AppModule } from './app.module';",
    ...header,
    'async function bootstrap() {',
    '  const app = await NestFactory.create(AppModule);',
    ...bootLines.map((l) => `  ${l}`),
    '  await app.listen(3000);',
    '}',
    'bootstrap();',
  ].join('\n')];
  const appModule = ['app.module.ts', [
    "import { Module } from '@nestjs/common';",
    ...controllers.map(([cls, file]) => `import { ${cls} } from './${file}';`),
    `@Module({ controllers: [${controllers.map(([cls]) => cls).join(', ')}] })`,
    'export class AppModule {}',
  ].join('\n')];
  return [main, appModule, ...files];
}

const twoVerbController = ['health.controller.ts', [
  "import { Controller, Get, Post } from '@nestjs/common';",
  "@Controller('health')",
  'export class HealthController {',
  '  @Get() check() {}',
  '  @Post() ping() {}',
  '}',
].join('\n')];

test('an exclude written { path, method } frees that one method of the route from the prefix', () => {
  const result = routesOf(appWith(["app.setGlobalPrefix('api', { exclude: [{ path: 'health', method: RequestMethod.GET }] });"], [['HealthController', 'health.controller']], [twoVerbController]));
  assert.deepEqual(pathsOf(result.routes), ['GET /health', 'POST /api/health']);
  assert.ok(result.routes.every((r) => r.grade === undefined), 'every entry was read, so every address is sure');
});

test('an exclude pattern is matched the way Nest matches one: a parameter, an optional wildcard, and no case', () => {
  const docs = ['docs.controller.ts', [
    "import { Controller, Get } from '@nestjs/common';",
    "@Controller('docs')",
    'export class DocsController {',
    "  @Get(':page') page() {}",
    "  @Get('a/b') deep() {}",
    '}',
  ].join('\n')];
  const users = ['users.controller.ts', [
    "import { Controller, Get } from '@nestjs/common';",
    "@Controller('users')",
    'export class UsersController {',
    "  @Get(':id') one() {}",
    "  @Get(':id/posts') posts() {}",
    '}',
  ].join('\n')];
  const result = routesOf(appWith(["app.setGlobalPrefix('api', { exclude: ['DOCS{/*rest}', 'users/:id'] });"],
    [['DocsController', 'docs.controller'], ['UsersController', 'users.controller']], [docs, users]));
  assert.deepEqual(pathsOf(result.routes), ['GET /api/users/{id}/posts', 'GET /docs/a/b', 'GET /docs/{page}', 'GET /users/{id}']);
});

test('the profile\'s globalPrefixExclude stands for an exclude list the bootstrap builds at run time, and makes the addresses sure', () => {
  const files = appWith(['app.setGlobalPrefix(\'api\', { exclude: [...LANGUAGE_ROUTES] });'], [['HealthController', 'health.controller']], [twoVerbController]);
  const guessed = routesOf(files);
  assert.ok(guessed.routes.every((r) => r.grade === 'HEURISTIC'), 'a spread list may name any route');
  const declared = routesOf(files, { globalPrefixExclude: ['health'] });
  assert.deepEqual(pathsOf(declared.routes), ['GET /health', 'POST /health']);
  assert.ok(declared.routes.every((r) => r.grade === undefined));
});

test('a prefix set under a condition, or set twice to different values, is not known, and no route is made', () => {
  for (const lines of [
    ["if (process.env.X) app.setGlobalPrefix('a');"],
    ["if (process.env.X) app.setGlobalPrefix('a'); else app.setGlobalPrefix('b');"],
    ["app.setGlobalPrefix('a');", "app.setGlobalPrefix('b');"],
  ]) {
    const result = routesOf(appWith(lines, [['HealthController', 'health.controller']], [twoVerbController]));
    assert.deepEqual(result.routes, [], lines.join(' '));
    assert.ok(kindsOf(result.diagnostics).includes('TS_PREFIX_UNREAD'), lines.join(' '));
  }
  const twice = routesOf(appWith(["app.setGlobalPrefix('a');", "app.setGlobalPrefix('a');"], [['HealthController', 'health.controller']], [twoVerbController]));
  assert.deepEqual(pathsOf(twice.routes), ['GET /a/health', 'POST /a/health'], 'the same value twice is one value');
});

test('a function of the project the application is handed to is read for its settings, under the name its parameter gives it', () => {
  const configure = ['configure.ts', 'export function configure(server) {\n  server.setGlobalPrefix(\'api\');\n}\n'];
  const result = routesOf(appWith(['configure(app);'], [['HealthController', 'health.controller']], [twoVerbController, configure],
    { header: ["import { configure } from './configure';"] }));
  assert.deepEqual(pathsOf(result.routes), ['GET /api/health', 'POST /api/health']);
});

test('the application handed to code this engine does not read leaves its settings unknown, not absent', () => {
  const result = routesOf(appWith(['const setup = makeSetup();', 'setup(app);'], [['HealthController', 'health.controller']], [twoVerbController]));
  assert.deepEqual(result.routes, []);
  const said = result.diagnostics.find((d) => d.kind === 'TS_PREFIX_UNREAD');
  assert.match(said.reason, /handed to setup, which this engine does not read/);
  // A package's function is the package's: SwaggerModule.setup(path, app, doc) changes no address.
  const swagger = routesOf(appWith(["SwaggerModule.setup('docs', app, document);"], [['HealthController', 'health.controller']], [twoVerbController],
    { header: ["import { SwaggerModule } from '@nestjs/swagger';"] }));
  assert.deepEqual(pathsOf(swagger.routes), ['GET /health', 'POST /health']);
});

// ---------------------------------------------------------------------------
// what a class says is read the way Nest reads it
// ---------------------------------------------------------------------------

test('a spread in a controller\'s options or a module\'s leaves what it may set unknown, and nothing is made of it', () => {
  const spreadController = ['spread.controller.ts', [
    "import { Controller, Get } from '@nestjs/common';",
    "const options = { path: 'private' };",
    '@Controller({ ...options })',
    'export class SpreadController {',
    '  @Get() get() {}',
    '}',
  ].join('\n')];
  const result = routesOf(appWith([], [['SpreadController', 'spread.controller']], [spreadController]));
  assert.deepEqual(result.routes, []);
  assert.ok(kindsOf(result.diagnostics).includes('TS_ROUTE_PATH_UNREAD'));

  const main = appWith([], [], [])[0];
  const spreadModule = ['app.module.ts', [
    "import { Module } from '@nestjs/common';",
    "import { HealthController } from './health.controller';",
    'const options = { controllers: [] };',
    '@Module({ controllers: [HealthController], ...options })',
    'export class AppModule {}',
  ].join('\n')];
  const registered = routesOf([main, spreadModule, twoVerbController]);
  assert.deepEqual(registered.routes, [], 'the spread may replace the controllers list');
  assert.ok(kindsOf(registered.diagnostics).includes('TS_MODULE_UNREAD'));
});

test('a decorator imported under another name is read by the name its package gives it; one of the project\'s own is not the framework\'s', () => {
  const aliased = ['aliased.controller.ts', [
    "import { Controller as Ctl, Get as GET } from '@nestjs/common';",
    "@Ctl('x')",
    'export class AliasedController {',
    '  @GET() get() {}',
    '}',
  ].join('\n')];
  const namespaced = ['ns.controller.ts', [
    "import * as common from '@nestjs/common';",
    "@common.Controller('y')",
    'export class NsController {',
    '  @common.Get() get() {}',
    '}',
  ].join('\n')];
  const own = ['own.controller.ts', [
    "import { Controller } from './my-decorators';",
    "import { Get } from '@nestjs/common';",
    "@Controller('z')",
    'export class OwnController {',
    '  @Get() get() {}',
    '}',
  ].join('\n')];
  const myDecorators = ['my-decorators.ts', 'export function Controller(path) { return () => undefined; }\n'];
  const result = routesOf(appWith([], [['AliasedController', 'aliased.controller'], ['NsController', 'ns.controller'], ['OwnController', 'own.controller']],
    [aliased, namespaced, own, myDecorators]));
  assert.deepEqual(pathsOf(result.routes), ['GET /x', 'GET /y']);
  const said = result.diagnostics.find((d) => d.kind === 'TS_ROUTES_WITHOUT_CONTROLLER');
  assert.match(said.reason, /own\.controller\.ts#OwnController/);
});

test('a route method a controller inherits from a class of the project is served under the controller\'s path, handled by the method that declares it', () => {
  const base = ['base.controller.ts', [
    "import { Get } from '@nestjs/common';",
    'export class BaseController {',
    "  @Get('ping') ping() {}",
    '}',
  ].join('\n')];
  const child = ['child.controller.ts', [
    "import { Controller } from '@nestjs/common';",
    "import { BaseController } from './base.controller';",
    "@Controller('x')",
    'export class ChildController extends BaseController {}',
  ].join('\n')];
  const result = routesOf(appWith([], [['ChildController', 'child.controller']], [base, child]));
  assert.deepEqual(result.routes.map((r) => [`${r.verb} ${r.path}`, `${r.file}#${r.cls}.${r.method}`]), [['GET /x/ping', 'base.controller.ts#BaseController.ping']]);
  assert.ok(!kindsOf(result.diagnostics).includes('TS_ROUTES_WITHOUT_CONTROLLER'), 'a base a controller extends is not a class whose routes go unserved');
});

test('a module with no options is an empty module, not one that could not be read', () => {
  const empty = ['empty.module.ts', "import { Module } from '@nestjs/common';\n@Module()\nexport class EmptyModule {}\n"];
  const appModule = ['app.module.ts', [
    "import { Module } from '@nestjs/common';",
    "import { EmptyModule } from './empty.module';",
    "import { HealthController } from './health.controller';",
    '@Module({ imports: [EmptyModule], controllers: [HealthController] })',
    'export class AppModule {}',
  ].join('\n')];
  const result = routesOf([appWith([], [], [])[0], appModule, empty, twoVerbController]);
  assert.deepEqual(pathsOf(result.routes), ['GET /health', 'POST /health']);
  assert.ok(!kindsOf(result.diagnostics).includes('TS_MODULE_UNREAD'));
});
