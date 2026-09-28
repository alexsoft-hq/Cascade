// api_groups.test.mjs — a route's API group is read below its deployment prefix, wherever the engine groups routes.
//
// An application deployed under a global prefix and a version (`/api/v1/...`)
// used to be ONE group, `api`, because a group was the first segment of the
// whole address: the overview map and the Graph tab drew one hub with every
// table around it. A lane that knows where the deployment prefix ends writes
// the first segment after it as `apiGroup`, and every view that groups routes
// reads it, falling back to the old rule where no lane wrote one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Graph } from '../src/core/graph.mjs';
import { addTsFacts } from '../src/adapters/ts_bridge.mjs';
import { factsOfFile } from '../adapters/ts/tsfacts.mjs';
import { groupOfEndpoint, laneGroupOf, walkEndpoints, ROOT_GROUP } from '../src/core/walks.mjs';
import { groupRule } from '../src/core/summary.mjs';
import { buildCoupling } from '../src/core/coupling.mjs';

const recordsOf = (files) => files.flatMap(([name, source]) => factsOfFile(name, source));

/** A NestJS application under `api` and URI version 1, with a routed module, a users controller and a bare one. */
function prefixedApp() {
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
    "import { RouterModule } from '@nestjs/core';",
    "import { AdminModule } from './admin.module';",
    "import { UsersController } from './users.controller';",
    "import { RootController } from './root.controller';",
    '@Module({',
    "  imports: [AdminModule, RouterModule.register([{ path: 'admin', module: AdminModule }])],",
    '  controllers: [UsersController, RootController],',
    '})',
    'export class AppModule {}',
  ].join('\n')];
  const adminModule = ['admin.module.ts', [
    "import { Module } from '@nestjs/common';",
    "import { QueueController } from './queue.controller';",
    '@Module({ controllers: [QueueController] })',
    'export class AdminModule {}',
  ].join('\n')];
  const controller = (file, cls, path, methods) => [`${file}.ts`, [
    "import { Controller, Get } from '@nestjs/common';",
    `@Controller(${path === null ? '' : `'${path}'`})`,
    `export class ${cls} {`,
    ...methods.map(([m, p]) => `  @Get(${p === null ? '' : `'${p}'`}) ${m}() {}`),
    '}',
  ].join('\n')];
  return [main, appModule, adminModule,
    controller('users.controller', 'UsersController', 'users', [['list', null], ['one', ':id']]),
    controller('queue.controller', 'QueueController', 'queue', [['jobs', 'jobs']]),
    controller('root.controller', 'RootController', null, [['sitemap', 'sitemap.xml'], ['home', null]])];
}

function prefixedGraph() {
  const g = new Graph();
  addTsFacts(g, recordsOf(prefixedApp()));
  return g;
}

test('the TypeScript bridge writes a route\'s group below the global prefix and the version, and a module path is part of it', () => {
  const g = prefixedGraph();
  const group = (id) => g.nodes.get(`endpoint:${id}`)?.apiGroup;
  assert.equal(group('GET /api/v1/users'), 'users');
  assert.equal(group('GET /api/v1/users/{id}'), 'users');
  // RouterModule gave AdminModule's controllers `admin`: a path the application
  // chose for a part of itself, not where it is deployed, so it is the group.
  assert.equal(group('GET /api/v1/admin/queue/jobs'), 'admin');
  assert.equal(group('GET /api/v1/sitemap.xml'), 'sitemap.xml');
  assert.equal(group('GET /api/v1'), ROOT_GROUP, 'a route with no path of its own is the root group');
});

test('router_module_path_is_part_of_api_group: two modules mounted at admin and public are two groups, though their controllers share a path', () => {
  const files = prefixedApp().filter(([name]) => !['app.module.ts', 'admin.module.ts'].includes(name));
  const module = (file, cls, ctl, ctlFile) => [`${file}.ts`, [
    "import { Module } from '@nestjs/common';",
    `import { ${ctl} } from './${ctlFile}';`,
    `@Module({ controllers: [${ctl}] })`,
    `export class ${cls} {}`,
  ].join('\n')];
  const controller = (file, cls) => [`${file}.ts`, [
    "import { Controller, Get } from '@nestjs/common';",
    "@Controller('users')",
    `export class ${cls} { @Get() list() {} }`,
  ].join('\n')];
  const appModule = ['app.module.ts', [
    "import { Module } from '@nestjs/common';",
    "import { RouterModule } from '@nestjs/core';",
    "import { AdminModule } from './admin.module';",
    "import { PublicModule } from './public.module';",
    '@Module({',
    "  imports: [AdminModule, PublicModule, RouterModule.register([{ path: 'admin', module: AdminModule }, { path: 'public', module: PublicModule }])],",
    '})',
    'export class AppModule {}',
  ].join('\n')];
  const g = new Graph();
  addTsFacts(g, recordsOf([...files, appModule,
    module('admin.module', 'AdminModule', 'AdminUsersController', 'admin-users.controller'),
    module('public.module', 'PublicModule', 'PublicUsersController', 'public-users.controller'),
    controller('admin-users.controller', 'AdminUsersController'), controller('public-users.controller', 'PublicUsersController')]));
  assert.equal(g.nodes.get('endpoint:GET /api/v1/admin/users')?.apiGroup, 'admin');
  assert.equal(g.nodes.get('endpoint:GET /api/v1/public/users')?.apiGroup, 'public');
});

test('every view that groups routes reads the lane\'s group, and the first path segment where no lane wrote one', () => {
  const g = prefixedGraph();
  const groups = new Set(walkEndpoints(g).endpoints.map((ep) => ep.group));
  assert.deepEqual([...groups].sort(), [ROOT_GROUP, 'admin', 'sitemap.xml', 'users']);
  assert.ok(!groups.has('api'), 'no route falls into the deployment prefix');
  // coupling counts its groups off the same walk
  assert.deepEqual(buildCoupling(g, {}).groups.map((x) => x.group).sort(), [ROOT_GROUP, 'admin', 'sitemap.xml', 'users']);
  // a route another lane made, with no lane group, keeps the old rule
  assert.equal(groupOfEndpoint({ path: '/product/list/{id}' }), 'product');
  assert.equal(laneGroupOf({ path: '/api/v1/x' }), null);
  assert.equal(laneGroupOf({ apiGroup: '' }), null, 'an empty group is no group');
});

test('a declared package depth still wins over the lane\'s group: the project said where its modules are', () => {
  const node = { path: '/api/v1/users', apiGroup: 'users', handler: 'com.acme.shop.user.UserController#list' };
  assert.equal(groupOfEndpoint(node), 'users');
  assert.equal(groupOfEndpoint(node, { packageDepth: 3 }), 'com.acme.shop');
});

test('the summary groups file-keyed handlers by the directory their code sits in, not by the dots of the file name', () => {
  const g = new Graph();
  const route = (verb, path, handler) => {
    g.addNode({ id: `endpoint:${verb} ${path}`, path, httpMethod: verb, handler });
    g.addEdge({ from: `endpoint:${verb} ${path}`, to: handler, type: 'HANDLES', grade: 'EXACT' });
  };
  route('GET', '/api/v1/users', 'symbol:apps/api/src/app/user/user.controller.ts#UserController.list');
  route('GET', '/api/v1/orders', 'symbol:apps/api/src/app/order/order.controller.ts#OrderController.list');
  route('GET', '/api/v1/orders/{id}', 'symbol:apps/api/src/app/order/order.controller.ts#OrderController.one');
  const { endpoints } = walkEndpoints(g);
  const { rule, groupOf } = groupRule(g, endpoints, null);
  assert.deepEqual(rule, { kind: 'code-path', commonPrefix: 'apps/api/src/app', by: 'directory' });
  assert.deepEqual([...new Set(groupOf.values())].sort(), ['order', 'user']);
});

test('the summary takes the lane\'s group where every handler sits in one directory and every route has one', () => {
  const g = new Graph();
  for (const [path, group, m] of [['/api/v1/users', 'users', 'list'], ['/api/v1/orders', 'orders', 'orders']]) {
    const handler = `symbol:src/app.controller.ts#AppController.${m}`;
    g.addNode({ id: `endpoint:GET ${path}`, path, httpMethod: 'GET', handler, apiGroup: group });
    g.addEdge({ from: `endpoint:GET ${path}`, to: handler, type: 'HANDLES', grade: 'EXACT' });
  }
  const { rule, groupOf } = groupRule(g, walkEndpoints(g).endpoints, null);
  assert.equal(rule.kind, 'lane');
  assert.deepEqual([...groupOf.values()].sort(), ['orders', 'users']);
});
