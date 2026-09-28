// chainlayout.test.mjs — how a chain is named, ordered, sized and folded (RM67).
//
// The Flow and Impact lanes cut every name to what a 180px column held, so the
// drawing named nothing, and its lines crossed in a knot. src/viewer/chainlayout.mjs
// is the one place both the live lanes and the saved SVG ask how to name a node,
// in what order to put a lane, how wide to make it and what to fold. This holds
// each of those rules against the shapes of id the corpus really has: Java
// methods and MyBatis statements (mall, jeecg-boot), TypeScript methods and
// Prisma or TypeORM call sites (ghostfolio), web functions (Vue, Angular), routes,
// screens, tables and columns.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHAIN_FIT, GRADE_DASH, labelParts, chainLabels, fitLines, laneWidth,
  orderLanes, countCrossings, chainThrough, foldLane,
} from '../src/viewer/chainlayout.mjs';

const label = (id) => labelParts(id).at(0);
const labels = (ids) => [...chainLabels(ids).values()].map((x) => x.text);

test('a node is named by what tells it apart: Class.method, Mapper.statement, Service.method #n, module.function', () => {
  assert.equal(label('symbol:com.macro.mall.portal.service.impl.OmsPortalOrderServiceImpl#generateOrder'), 'OmsPortalOrderServiceImpl.generateOrder');
  assert.equal(label('statement:com.macro.mall.mapper.PmsProductMapper.selectByExample'), 'PmsProductMapper.selectByExample');
  // An ORM statement is a call site, not a mapper: the method and which of its calls.
  assert.equal(label('statement:prisma:apps/api/src/app/user/user.service.ts#UserService.deleteUser/0'), 'UserService.deleteUser #0');
  assert.equal(label('statement:typeorm:src/article/article.service.ts#ArticleService.findAll/2'), 'ArticleService.findAll #2');
  // A TypeScript method is its class, not its file.
  assert.equal(label('symbol:apps/api/src/app/user/user.controller.ts#UserController.deleteOwnUser'), 'UserController.deleteOwnUser');
  // A web function is its module; an index file is the folder it sits in.
  assert.equal(label('symbol:../mall-admin-web/src/apis/brand.ts#getBrandAPI'), 'brand.getBrandAPI');
  assert.equal(label('symbol:jeecgboot-vue3/src/views/system/user/index.vue#handleEdit'), 'user.handleEdit');
  assert.equal(label('symbol:src/views/pms/BrandDetail.vue#(setup)'), 'BrandDetail (setup)');
  assert.equal(label('column:pms_product.name'), 'pms_product.name');
  assert.equal(label('column:public.users.email'), 'users.email', 'a column is table.column, without its schema');
  assert.equal(label('table:pms_product'), 'pms_product');
  assert.equal(label('screen:/pms/product'), '/pms/product');
});

test('a route keeps its verb and the segments that tell it apart, and gives up its middle', () => {
  assert.equal(label('endpoint:GET /product/detail/{id}'), 'GET /product/detail/{id}', 'a short route is whole');
  const long = label('endpoint:GET /admin-api/product/spu/category/attribute/value/page/list/export-excel');
  assert.match(long, /^GET \/admin-api\/…\//, 'the head stays');
  assert.match(long, /\/list\/export-excel$/, 'the tail stays');
  assert.ok(long.length <= CHAIN_FIT.routeMax, long);
  // A tail of path variables is kept together with the NAME before it.
  const vars = label('endpoint:GET /sys/alpha/bravo/charlie/getLoginUser/{token}/{thirdType}');
  assert.match(vars, /…\/.*getLoginUser\/\{token\}\/\{thirdType\}$/, vars);
});

test('two nodes that would read the same get what tells them apart, and only they do', () => {
  const [a, b, c] = labels([
    'symbol:com.x.order.OrderService#save',
    'symbol:com.x.cart.OrderService#save',
    'symbol:com.x.cart.CartService#save',
  ]);
  assert.equal(a, 'order.OrderService.save');
  assert.equal(b, 'cart.OrderService.save');
  assert.equal(c, 'CartService.save', 'a name nobody shares stays short');
  // Two files of one name in two folders; a .vue and a .js of one stem.
  const [d, e] = labels(['symbol:src/views/demo/role/index.vue#handleEdit', 'symbol:src/views/system/role/index.vue#handleEdit']);
  assert.notEqual(d, e);
  assert.match(d, /demo/); assert.match(e, /system/);
  const [f, g] = labels(['symbol:src/views/rows.vue#load', 'symbol:src/views/rows.js#load']);
  assert.deepEqual([f, g], ['rows.vue#load', 'rows.js#load']);
  // The same id twice is ONE node, not a collision.
  assert.deepEqual(labels(['table:t', 'table:t']), ['t']);
});

test('a long name takes two lines at most, broken where the name breaks, and gives up its middle, never its tail', () => {
  assert.deepEqual(fitLines('OmsPortalOrderServiceImpl.calcIntegrationAmount', 30), ['OmsPortalOrderServiceImpl.', 'calcIntegrationAmount']);
  assert.deepEqual(fitLines('pms_product', 30), ['pms_product']);
  const cut = fitLines(`VeryLong${'Segment'.repeat(20)}.selectByExample`, 24);
  assert.equal(cut.length, 2);
  assert.match(cut.join(''), /…/);
  assert.match(cut[1], /selectByExample$/, 'the tail is what tells two rows apart');
  for (const line of cut) assert.ok(line.length <= 24, line);
});

test('a lane is as wide as its longest name needs, between the floor and the cap', () => {
  assert.equal(laneWidth(['t']).width, CHAIN_FIT.min);
  assert.equal(laneWidth(['x'.repeat(500)]).width, CHAIN_FIT.max);
  const mid = laneWidth(['OmsPortalOrderServiceImpl.generate']);
  assert.ok(mid.width > CHAIN_FIT.min && mid.width < CHAIN_FIT.max, String(mid.width));
  assert.ok(mid.perLine >= 'OmsPortalOrderServiceImpl.generate'.length, 'a name that sets the width fits on one line');
});

/** Two lanes whose links cross when drawn in the engine's order. */
function crossed() {
  const lanes = [
    [{ key: 'a', group: 'g' }, { key: 'b', group: 'g' }, { key: 'c', group: 'g' }],
    [{ key: 'x', group: '1|EXACT' }, { key: 'y', group: '1|EXACT' }, { key: 'z', group: '1|SOUND_SET' }, { key: 'w', group: '1|SOUND_SET' }],
  ];
  const links = [{ from: 'a', to: 'y' }, { from: 'c', to: 'x' }, { from: 'a', to: 'w' }, { from: 'c', to: 'z' }, { from: 'b', to: 'b2' }];
  return { lanes, links };
}

test('ordering cuts crossings, the same way every time, and never moves a row out of its hop and grade', () => {
  const { lanes, links } = crossed();
  const before = countCrossings(lanes, links);
  const out = orderLanes(lanes, links);
  assert.ok(before > 0);
  assert.ok(countCrossings(out, links) < before, `${before} -> ${countCrossings(out, links)}`);
  assert.deepEqual(orderLanes(lanes, links), out, 'deterministic');
  // The candidate band stays under the proven one: the groups keep their order and their rows.
  assert.deepEqual(out[1].map((r) => r.group), lanes[1].map((r) => r.group));
  assert.deepEqual(new Set(out[1].slice(0, 2).map((r) => r.key)), new Set(['x', 'y']));
  // The input is not touched.
  assert.deepEqual(lanes[1].map((r) => r.key), ['x', 'y', 'z', 'w']);
});

test('the chain through a node is what led to it and what it leads to, not everything beside it', () => {
  const links = [{ from: 'e', to: 's1' }, { from: 's1', to: 't1' }, { from: 's1', to: 't2' }, { from: 'e', to: 's2' }, { from: 's2', to: 't2' }];
  assert.deepEqual([...chainThrough(links, 't1')].sort(), ['e', 's1', 't1']);
  assert.deepEqual([...chainThrough(links, 's2')].sort(), ['e', 's2', 't2']);
});

/** A lane of `n` rows: `owners` rows per owner, all in one hop and grade. */
const laneOf = (n, per) => Array.from({ length: n }, (_, i) => ({ key: `k${i}`, group: '3|SOUND_SET', owner: `Owner${Math.floor(i / per)}` }));

test('a long lane folds one owner\'s rows into one row, keeps what was picked or found, and drops nothing', () => {
  assert.equal(foldLane(laneOf(8, 4)).items.length, 8, 'a short lane is drawn whole');
  const rows = laneOf(40, 5);
  const f = foldLane(rows, { keep: new Set(['k7']), lane: 'services' });
  const groups = f.items.filter((it) => it.type === 'group');
  assert.ok(groups.length > 0);
  for (const g of groups) assert.ok(g.rows.every((r) => r.owner === g.owner), 'a group is one owner');
  // k7 is kept as its own row, and the rest of its owner still fold.
  assert.ok(f.items.some((it) => it.type === 'row' && it.key === 'k7'));
  // Every row is somewhere: drawn, or standing behind a drawn item.
  assert.equal(f.proxy.size, rows.length);
  for (const r of rows) assert.ok(f.items.some((it) => it.key === f.proxy.get(r.key)), r.key);
  // Opening a group draws its rows in place.
  const g0 = groups[0];
  const open = foldLane(rows, { keep: new Set(['k7']), lane: 'services', open: new Set([g0.key]) });
  for (const r of g0.rows) assert.equal(open.proxy.get(r.key), r.key);
});

test('a lane still long after grouping shows its first items and folds the rest into one "more"', () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ key: `k${i}`, group: '3|SOUND_SET', owner: `O${i}` }));
  const f = foldLane(rows, { lane: 'services', keep: new Set(['k25']) });
  const more = f.items.find((it) => it.type === 'more');
  assert.ok(more);
  assert.equal(f.items.filter((it) => it.type === 'row').length, CHAIN_FIT.foldKeep + 1, 'the first ones, and the kept one');
  assert.ok(f.items.some((it) => it.key === 'k25'), 'a kept row is never behind "more"');
  assert.equal(more.rows.length, 30 - CHAIN_FIT.foldKeep - 1);
  assert.equal(foldLane(rows, { lane: 'services', open: new Set(['services|more']) }).items.length, 30);
});

test('the dash table is the page\'s: EXACT solid, SOUND_SET dashed, HEURISTIC dash-dot, the rest dotted', () => {
  assert.equal(GRADE_DASH.EXACT, null);
  assert.equal(GRADE_DASH.SOUND_SET.split(' ').length, 2);
  assert.equal(GRADE_DASH.HEURISTIC.split(' ').length, 4, 'dash-dot is four numbers');
  assert.equal(GRADE_DASH.RUNTIME_ONLY, GRADE_DASH.UNRESOLVED);
});
