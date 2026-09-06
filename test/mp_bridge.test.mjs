// mp_bridge.test.mjs — the MyBatis-Plus bridge over synthetic `com.example` facts.
//
// Everything here is hand-written evidence in the shape JavaFacts emits, so
// every expectation is read off the ANNOTATIONS and the wrapper ops, not off the
// bridge. What is pinned down:
//   1. a declared name is EXACT and a derived one is HEURISTIC — and a catalog
//      hit records itself as evidence WITHOUT promoting the grade (I-1);
//   2. the generic CRUD nobody wrote becomes a statement per (owner, method),
//      with the access each verb actually performs;
//   3. a condition wrapper's method references and string literals become the
//      columns the statement touches, and a wrapper this lane cannot see through
//      makes the statement say `columnsRuntimeOnly` instead of guessing;
//   4. @TableLogic turns a delete into a WRITE of the flag column, and every
//      query on the entity into a READ of it;
//   5. the chain endpoint -> controller -> service -> statement -> column comes
//      back through the shipped tools.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Graph } from '../src/core/graph.mjs';
import { buildGraphFromSql } from '../src/adapters/sql_bridge.mjs';
import { addJavaFacts } from '../src/adapters/java_bridge.mjs';
import {
  addMybatisPlusFacts, mpPhysicalName, OP_KINDS, MAPPER_BUILTINS, SERVICE_BUILTINS,
  wrapperFragmentStatements, wrapperFragments, wrapperFragmentBases, normalizeMpPlaceholders,
} from '../src/adapters/mp_bridge.mjs';

// ---------------------------------------------------------------------------
// fact builders — the shapes adapters/java/JavaFacts.java emits (javafacts/6)
// ---------------------------------------------------------------------------

const P = 'com.example';
const fq = (s) => `${P}.${s}`;

const type = (simple, extra = {}) => ({
  kind: 'type', fqn: fq(simple), typeKind: extra.typeKind ?? 'class', package: P,
  abstract: extra.abstract === true,
  annotations: extra.annotations ?? [],
  implements: extra.implements ?? [], implementsArgs: extra.implementsArgs ?? [],
  extends: extra.extends ?? null, extendsArgs: extra.extendsArgs ?? [],
  typeParams: extra.typeParams ?? [], typeParamBounds: extra.typeParamBounds ?? [],
  client: null, declaredMethods: extra.declaredMethods ?? [],
  file: `${simple}.java`,
});

const field = (name, extra = {}) => ({
  name, typeSimple: extra.typeSimple ?? 'String', line: extra.line ?? 1,
  column: extra.column ?? null, exist: extra.exist !== false,
  id: extra.id === true, idType: extra.idType ?? null,
  logic: extra.logic === true, version: extra.version === true, fill: null,
  static: extra.static === true, transient: extra.transient === true,
});

const mpEntity = (simple, extra = {}) => ({
  kind: 'mpEntity', fqn: fq(simple),
  tableName: extra.tableName ?? null, schema: null,
  tableNameDeclared: typeof extra.tableName === 'string',
  superclass: extra.superclass ?? null, fields: extra.fields ?? [],
  line: 1, file: `${simple}.java`,
});

const mpMapper = (simple, entitySimple) => ({
  kind: 'mpMapper', fqn: fq(simple), base: 'BaseMapper',
  entityTypeSimple: entitySimple, line: 1, file: `${simple}.java`,
});

const mpService = (simple, base, mapperSimple, entitySimple) => ({
  kind: 'mpService', fqn: fq(simple), base,
  mapperTypeSimple: mapperSimple, entityTypeSimple: entitySimple,
  line: 1, file: `${simple}.java`,
});

const call = (from, receiver, method, toTypeSimple, via = 'field') => ({
  kind: 'call', from, receiver, method, toTypeSimple, via, file: 'x.java',
});

const op = (name, args = [], props = [], line = 10) => ({ name, args, props, line });
const prop = (owner, getter) => ({
  owner, method: getter,
  property: getter.replace(/^(get|is)/, (m) => '').replace(/^./, (c) => c.toLowerCase()),
});
const sink = (kind, receiver, receiverTypeSimple, method, line = 12) => ({ kind, receiver, receiverTypeSimple, method, line });
const mpWrapper = (from, extra = {}) => ({
  kind: 'mpWrapper', from, var: extra.var ?? 'w',
  wrapperKind: extra.wrapperKind ?? 'lambda-query',
  entityTypeSimple: extra.entityTypeSimple ?? null,
  origin: extra.origin ?? 'new', builtBy: extra.builtBy ?? null,
  opsComplete: extra.opsComplete !== false,
  factoryReceiver: null, factoryReceiverType: null,
  ops: extra.ops ?? [], sinks: extra.sinks ?? [],
  line: extra.line ?? 9, file: 'x.java',
});

/**
 * A shop, spelled the way a MyBatis-Plus project spells one:
 *   ShopItem       @TableName("shop_item"), @TableId id, @TableField("cost") price,
 *                  @TableField(exist=false) formatted, transient scratch
 *   ShopOrder      NO @TableName -> the name is DERIVED
 *   ShopItemMapper extends BaseMapper<ShopItem>
 *   IShopItemService extends IService<ShopItem>, ShopItemServiceImpl its impl
 *   ItemController#list -> service.list(wrapper)
 */
function shopFacts() {
  return [
    type('ShopItem'),
    mpEntity('ShopItem', {
      tableName: 'shop_item',
      fields: [
        field('id', { id: true, idType: 'ASSIGN_ID' }),
        field('name'),
        field('price', { column: 'cost', typeSimple: 'BigDecimal' }),
        field('delFlag', { logic: true, typeSimple: 'Integer' }),
        field('formatted', { exist: false }),
        field('scratch', { transient: true }),
        field('serialVersionUID', { static: true, typeSimple: 'long' }),
      ],
    }),
    type('ShopOrder'),
    mpEntity('ShopOrder', {
      fields: [field('id', { id: true }), field('orderCode'), field('itemId')],
    }),

    type('ShopItemMapper', { typeKind: 'interface', implements: ['BaseMapper'], implementsArgs: [['ShopItem']] }),
    mpMapper('ShopItemMapper', 'ShopItem'),
    type('ShopOrderMapper', { typeKind: 'interface', implements: ['BaseMapper'], implementsArgs: [['ShopOrder']] }),
    mpMapper('ShopOrderMapper', 'ShopOrder'),

    type('IShopItemService', { typeKind: 'interface', implements: ['IService'], implementsArgs: [['ShopItem']] }),
    mpService('IShopItemService', 'IService', null, 'ShopItem'),
    type('ShopItemServiceImpl', {
      extends: 'ServiceImpl', extendsArgs: ['ShopItemMapper', 'ShopItem'],
      implements: ['IShopItemService'], implementsArgs: [[]],
      declaredMethods: ['findCheap/1'],
    }),
    mpService('ShopItemServiceImpl', 'ServiceImpl', 'ShopItemMapper', 'ShopItem'),

    type('ItemController', { annotations: ['RestController'] }),
    { kind: 'field', owner: fq('ItemController'), name: 'service', typeSimple: 'IShopItemService', file: 'ItemController.java' },
    { kind: 'endpoint', httpMethod: 'GET', path: '/item/list', handler: `${fq('ItemController')}#list`, handlerType: fq('ItemController'), line: 20, file: 'ItemController.java' },
    call(`${fq('ItemController')}#list`, 'service', 'list', 'IShopItemService'),
    mpWrapper(`${fq('ItemController')}#list`, {
      entityTypeSimple: 'ShopItem',
      ops: [op('eq', [null, null], [prop('ShopItem', 'getName')]), op('orderByDesc', ['cost'])],
      sinks: [sink('field', 'service', 'IShopItemService', 'list')],
    }),
  ];
}

const build = (facts, opts = {}, catalog = []) => {
  const g = catalog.length > 0
    ? buildGraphFromSql(catalog, [], { identifierCase: opts.identifierCase ?? 'exact' })
    : new Graph();
  addJavaFacts(g, facts, { packagePrefixes: [P] });
  const stats = addMybatisPlusFacts(g, facts, opts);
  return { g, stats };
};

const edgesFrom = (g, id) => g.outEdges(id).map((e) => g.edgeAt(e.idx));

// ---------------------------------------------------------------------------

test('mpPhysicalName: MyBatis-Plus\'s own two rules, and nothing in between', () => {
  assert.equal(mpPhysicalName('SysUser', 'underscore'), 'sys_user');
  assert.equal(mpPhysicalName('delFlag', 'underscore'), 'del_flag');
  assert.equal(mpPhysicalName('AiragKnowledgeDoc', 'underscore'), 'airag_knowledge_doc');
  // `identity` is the project that turned `table-underline` off.
  assert.equal(mpPhysicalName('SysUser', 'identity'), 'SysUser');
});

test('an undeclared naming strategy is ASSUMED, and every name it derived is HEURISTIC', () => {
  const { g, stats } = build(shopFacts());
  assert.equal(stats.namingStrategy, 'underscore');
  assert.equal(stats.namingStrategyDeclared, false);

  // DECLARED by @TableName -> EXACT, whatever the profile says.
  assert.equal(g.nodes.get('table:shop_item').mpMappingGrade, 'EXACT');
  // DERIVED by the assumed rule -> HEURISTIC.
  assert.equal(g.nodes.get('table:shop_order').mpMappingGrade, 'HEURISTIC');
  assert.equal(g.nodes.get('table:shop_order').mpEntity, fq('ShopOrder'));
});

test('declaring the strategy makes the SAME derived name EXACT — nothing else moves', () => {
  const loose = build(shopFacts());
  const strict = build(shopFacts(), { namingStrategy: 'underscore' });
  assert.equal(strict.g.nodes.get('table:shop_order').mpMappingGrade, 'EXACT');
  assert.equal(strict.stats.statements, loose.stats.statements);
  assert.equal(strict.g.edges.length, loose.g.edges.length);
});

test('a catalog hit is EVIDENCE, never a promotion (I-1)', () => {
  const catalog = [
    { kind: 'table', schema: null, table: 'shop_order' },
    { kind: 'column', schema: null, table: 'shop_order', column: 'id' },
    { kind: 'column', schema: null, table: 'shop_order', column: 'order_code' },
  ];
  const { g } = build(shopFacts(), {}, catalog);
  const t = g.nodes.get('table:shop_order');
  assert.equal(t.stub, undefined, 'the catalog declared it, so it is not a stub');
  assert.equal(t.mpCatalogMatch, true, 'the hit is recorded');
  assert.equal(t.mpMappingGrade, 'HEURISTIC', 'and it does NOT promote the guessed name');
});

test('a field owns no column when MyBatis-Plus would not persist it', () => {
  const { g } = build(shopFacts());
  const cols = g.edges.filter((e) => e.type === 'DECLARES' && e.from === 'table:shop_item')
    .map((e) => e.to.slice('column:'.length)).sort();
  // id, name, cost (declared by @TableField), del_flag — and NOT `formatted`
  // (@TableField(exist=false)), `scratch` (transient) or `serialVersionUID` (static).
  assert.deepEqual(cols, ['shop_item.cost', 'shop_item.del_flag', 'shop_item.id', 'shop_item.name']);
  // The DECLARED column name is EXACT even under an assumed strategy.
  const cost = g.edges.find((e) => e.type === 'DECLARES' && e.to === 'column:shop_item.cost');
  assert.equal(cost.grade, 'EXACT');
  const name = g.edges.find((e) => e.type === 'DECLARES' && e.to === 'column:shop_item.name');
  assert.equal(name.grade, 'HEURISTIC');
});

test('an inherited field is a column of the subclass\'s table', () => {
  const facts = [
    type('BaseEntity'),
    mpEntity('BaseEntity', { fields: [field('createBy'), field('createTime', { typeSimple: 'Date' })] }),
    type('Doc', { extends: 'BaseEntity' }),
    mpEntity('Doc', { tableName: 'doc', superclass: 'BaseEntity', fields: [field('id', { id: true }), field('title')] }),
    type('DocMapper', { typeKind: 'interface', implements: ['BaseMapper'], implementsArgs: [['Doc']] }),
    mpMapper('DocMapper', 'Doc'),
    type('Svc'),
    { kind: 'field', owner: fq('Svc'), name: 'docMapper', typeSimple: 'DocMapper', file: 'Svc.java' },
    call(`${fq('Svc')}#save`, 'docMapper', 'insert', 'DocMapper'),
  ];
  const { g } = build(facts);
  const written = edgesFrom(g, `statement:${fq('DocMapper')}.insert`)
    .filter((e) => e.type === 'WRITES').map((e) => e.to).sort();
  assert.deepEqual(written, ['column:doc.create_by', 'column:doc.create_time', 'column:doc.id', 'column:doc.title']);
});

test('a class with MP annotations that no mapper names is NOT a table (it is a DTO)', () => {
  const facts = [
    type('ItemVo'),
    mpEntity('ItemVo', { fields: [field('id', { id: true }), field('label')] }),
  ];
  const { g, stats } = build(facts);
  assert.equal(stats.entities, 0);
  assert.equal(g.nodes.has('table:item_vo'), false, 'a result-map DTO must not invent a table');
  assert.equal(stats.unresolved.filter((u) => u.reason === 'mp-entity-not-mapped').length, 1);
});

test('the generic CRUD verbs: what each built-in does to the row', () => {
  const facts = [
    ...shopFacts(),
    type('Jobs'),
    { kind: 'field', owner: fq('Jobs'), name: 'mapper', typeSimple: 'ShopOrderMapper', file: 'Jobs.java' },
    call(`${fq('Jobs')}#a`, 'mapper', 'insert', 'ShopOrderMapper'),
    call(`${fq('Jobs')}#b`, 'mapper', 'updateById', 'ShopOrderMapper'),
    call(`${fq('Jobs')}#c`, 'mapper', 'selectById', 'ShopOrderMapper'),
    call(`${fq('Jobs')}#d`, 'mapper', 'deleteById', 'ShopOrderMapper'),
  ];
  const { g } = build(facts);
  const access = (m) => edgesFrom(g, `statement:${fq('ShopOrderMapper')}.${m}`)
    .find((e) => e.type === 'EXECUTES').evidence.access;
  const cols = (m, t) => edgesFrom(g, `statement:${fq('ShopOrderMapper')}.${m}`)
    .filter((e) => e.type === t).map((e) => e.to).sort();

  // insert writes every mapped column — MyBatis-Plus writes the non-null ones,
  // and which those are is a run-time fact, so all of them are candidates.
  assert.equal(access('insert'), 'write');
  assert.deepEqual(cols('insert', 'WRITES'), ['column:shop_order.id', 'column:shop_order.item_id', 'column:shop_order.order_code']);
  // updateById writes the NON-ID columns and reads the key.
  assert.equal(access('updateById'), 'write');
  assert.deepEqual(cols('updateById', 'WRITES'), ['column:shop_order.item_id', 'column:shop_order.order_code']);
  assert.deepEqual(cols('updateById', 'READS'), ['column:shop_order.id']);
  // selectById reads the key AND projects the row.
  assert.equal(access('selectById'), 'read');
  assert.deepEqual(cols('selectById', 'READS'), ['column:shop_order.id']);
  // deleteById removes the row: no column is written, the key is read.
  assert.equal(access('deleteById'), 'delete');
  assert.deepEqual(cols('deleteById', 'WRITES'), []);
  assert.deepEqual(cols('deleteById', 'READS'), ['column:shop_order.id']);
});

test('a wrapper\'s method references and literals become the statement\'s columns', () => {
  const { g, stats } = build(shopFacts());
  // The call goes through the INTERFACE; the statement belongs to the impl the
  // dispatch edge reaches, which is where the inherited built-in actually runs.
  const sid = `statement:${fq('ShopItemServiceImpl')}.list`;
  assert.ok(g.nodes.has(sid), 'the statement is owned by the concrete ServiceImpl');
  assert.equal(g.nodes.get(sid).statementType, 'mp-builtin');
  const reads = edgesFrom(g, sid).filter((e) => e.type === 'READS');
  const byCol = Object.fromEntries(reads.map((e) => [e.to, e.evidence]));
  // `ShopItem::getName` -> the property `name` -> the derived column `name`.
  assert.ok(byCol['column:shop_item.name'].roles.includes('predicate'));
  assert.ok(byCol['column:shop_item.name'].via.includes('wrapper-op:eq'));
  // `orderByDesc("cost")` names a PHYSICAL column, as written -> EXACT.
  assert.ok(byCol['column:shop_item.cost'].roles.includes('predicate'));
  assert.equal(byCol['column:shop_item.cost'].literal, true);
  assert.equal(stats.columnsFromMethodReference, 1);
  assert.equal(stats.columnsFromLiteral, 1);
  assert.equal(g.nodes.get(sid).columnsRuntimeOnly, undefined, 'every op on this wrapper is visible');
});

test('a wrapper built somewhere this lane cannot see makes the columns RUNTIME_ONLY', () => {
  const facts = shopFacts().map((f) => (f.kind === 'mpWrapper'
    ? mpWrapper(f.from, {
      entityTypeSimple: 'ShopItem', origin: 'opaque-initializer',
      builtBy: 'QueryGenerator.initQueryWrapper', opsComplete: false,
      ops: [], sinks: f.sinks,
    })
    : f));
  const { g, stats } = build(facts);
  const n = g.nodes.get(`statement:${fq('ShopItemServiceImpl')}.list`);
  assert.equal(n.columnsRuntimeOnly, true);
  assert.match(n.columnsRuntimeOnlyReason, /QueryGenerator\.initQueryWrapper/);
  assert.equal(stats.statementsRuntimeOnlyColumns, 1);
  assert.equal(stats.wrappersRuntimeOnly, 1);
  // The TABLE is still a fact — the honest partial answer, not silence.
  assert.ok(edgesFrom(g, n.id).some((e) => e.type === 'EXECUTES' && e.to === 'table:shop_item'));
  assert.ok(n.unresolved.some((u) => u.reason === 'wrapper-columns-runtime-only'));
});

test('@TableLogic: a delete becomes a WRITE of the flag, and every query READS it', () => {
  const facts = [
    ...shopFacts(),
    type('Admin'),
    { kind: 'field', owner: fq('Admin'), name: 'service', typeSimple: 'IShopItemService', file: 'Admin.java' },
    call(`${fq('Admin')}#drop`, 'service', 'removeById', 'IShopItemService'),
  ];
  const { g, stats } = build(facts, { logicDeleteValue: '1' });
  const rm = `statement:${fq('ShopItemServiceImpl')}.removeById`;
  const n = g.nodes.get(rm);
  assert.equal(n.mpEvidence.logicDelete, true);
  assert.equal(n.mpEvidence.access, 'write');
  assert.match(n.mpEvidence.note, /sets del_flag to 1/);
  const e = edgesFrom(g, rm);
  const w = e.find((x) => x.type === 'WRITES' && x.to === 'column:shop_item.del_flag');
  assert.ok(w, 'the row stays; the flag column is written');
  assert.equal(w.evidence.logicDelete, true);
  assert.equal(e.find((x) => x.type === 'EXECUTES').evidence.access, 'write');
  assert.equal(stats.logicDeleteRewrites, 1);
  assert.equal(stats.logicDeleteEntities, 1);

  // …and the SELECT on the same entity reads it as the filter MP appends.
  const listRead = edgesFrom(g, `statement:${fq('ShopItemServiceImpl')}.list`)
    .find((x) => x.type === 'READS' && x.to === 'column:shop_item.del_flag');
  assert.ok(listRead);
  assert.equal(listRead.evidence.implicitFilter, true);

  // An entity WITHOUT @TableLogic still deletes.
  const facts2 = [
    ...facts,
    type('Purge'),
    { kind: 'field', owner: fq('Purge'), name: 'mapper', typeSimple: 'ShopOrderMapper', file: 'Purge.java' },
    call(`${fq('Purge')}#go`, 'mapper', 'deleteById', 'ShopOrderMapper'),
  ];
  const g2 = build(facts2).g;
  assert.equal(edgesFrom(g2, `statement:${fq('ShopOrderMapper')}.deleteById`)
    .find((x) => x.type === 'EXECUTES').evidence.access, 'delete');
});

test('a type the project OVERRODE keeps its own method — no generic statement is invented', () => {
  const facts = [
    ...shopFacts(),
    type('Reader'),
    { kind: 'field', owner: fq('Reader'), name: 'service', typeSimple: 'ShopItemServiceImpl', file: 'Reader.java' },
    // `findCheap` is declared by the impl (see its declaredMethods) and is not a
    // built-in; `count` is a built-in nobody declared.
    call(`${fq('Reader')}#a`, 'service', 'count', 'ShopItemServiceImpl'),
  ];
  const withDeclared = facts.map((f) => (f.kind === 'type' && f.fqn === fq('ShopItemServiceImpl')
    ? { ...f, declaredMethods: ['findCheap/1', 'count/1'] } : f));
  const plain = build(facts);
  const overridden = build(withDeclared);
  assert.ok(plain.g.nodes.has(`statement:${fq('ShopItemServiceImpl')}.count`));
  assert.equal(overridden.g.nodes.has(`statement:${fq('ShopItemServiceImpl')}.count`), false);
  assert.equal(overridden.stats.builtinsOverridden, 1);
  assert.ok(overridden.stats.unresolved.some((u) => u.reason === 'mp-builtin-overridden'));
});

test('a receiver typed by a TYPE PARAMETER produces one statement per binding', () => {
  // The shape jeecg-boot's JeecgController has: a shared base whose `service`
  // field is typed `S`, bound once per concrete subclass.
  const facts = [
    ...shopFacts(),
    type('BaseController', {
      typeParams: ['T', 'S'], typeParamBounds: [null, 'IService'],
      declaredMethods: ['exportXls/1'],
    }),
    { kind: 'field', owner: fq('BaseController'), name: 'service', typeSimple: 'S', file: 'BaseController.java' },
    call(`${fq('BaseController')}#exportXls`, 'service', 'list', 'S'),
    type('ItemExport', { extends: 'BaseController', extendsArgs: ['ShopItem', 'IShopItemService'] }),
    mpWrapper(`${fq('BaseController')}#exportXls`, {
      wrapperKind: 'query', entityTypeSimple: 'T', origin: 'opaque-initializer',
      builtBy: 'QueryGenerator.initQueryWrapper', opsComplete: false,
      ops: [op('in', ['id', null])],
      sinks: [sink('field', 'service', 'S', 'list')],
    }),
  ];
  const { g } = build(facts);
  const sid = `statement:${fq('ShopItemServiceImpl')}.list`;
  assert.ok(g.nodes.has(sid));
  // The wrapper's OWN entity is the type parameter `T` — unknowable on its own.
  // Resolved AT THE STATEMENT, `in("id")` is a column of the bound entity's table.
  assert.ok(edgesFrom(g, sid).some((e) => e.type === 'READS' && e.to === 'column:shop_item.id'
    && e.evidence.via.includes('wrapper-op:in')));
  assert.equal(g.nodes.get(sid).columnsRuntimeOnly, true);
});

test('a project base class between the code and ServiceImpl still names the entity', () => {
  // `class AppServiceImpl<M extends BaseMapper<T>, T> extends ServiceImpl<M, T>`
  // is jeecg-boot's JeecgServiceImpl in miniature: no project-specific base name
  // is hardcoded anywhere — the type arguments are substituted down the chain.
  const facts = [
    type('ShopItem'),
    mpEntity('ShopItem', { tableName: 'shop_item', fields: [field('id', { id: true }), field('name')] }),
    type('ShopItemMapper', { typeKind: 'interface', implements: ['BaseMapper'], implementsArgs: [['ShopItem']] }),
    mpMapper('ShopItemMapper', 'ShopItem'),
    type('AppServiceImpl', {
      typeParams: ['M', 'T'], typeParamBounds: ['BaseMapper', null],
      extends: 'ServiceImpl', extendsArgs: ['M', 'T'],
    }),
    mpService('AppServiceImpl', 'ServiceImpl', 'M', 'T'),
    type('ShopItemServiceImpl', { extends: 'AppServiceImpl', extendsArgs: ['ShopItemMapper', 'ShopItem'] }),
    type('Caller'),
    { kind: 'field', owner: fq('Caller'), name: 'svc', typeSimple: 'ShopItemServiceImpl', file: 'Caller.java' },
    call(`${fq('Caller')}#go`, 'svc', 'save', 'ShopItemServiceImpl'),
  ];
  const { g } = build(facts);
  const sid = `statement:${fq('ShopItemServiceImpl')}.save`;
  assert.ok(g.nodes.has(sid), 'the entity is found through the project\'s own generic base');
  assert.equal(g.nodes.get(sid).mpEvidence.entity, fq('ShopItem'));
  assert.deepEqual(edgesFrom(g, sid).filter((e) => e.type === 'WRITES').map((e) => e.to).sort(),
    ['column:shop_item.id', 'column:shop_item.name']);
});

test('two entities that map to ONE table are both named, at the weaker grade', () => {
  const facts = [
    type('SysLog'), mpEntity('SysLog', { fields: [field('id', { id: true })] }),
    type('ShardingSysLog'), mpEntity('ShardingSysLog', { tableName: 'sys_log', fields: [field('id', { id: true })] }),
    type('SysLogMapper', { typeKind: 'interface', implements: ['BaseMapper'], implementsArgs: [['SysLog']] }),
    mpMapper('SysLogMapper', 'SysLog'),
    type('ShardingSysLogMapper', { typeKind: 'interface', implements: ['BaseMapper'], implementsArgs: [['ShardingSysLog']] }),
    mpMapper('ShardingSysLogMapper', 'ShardingSysLog'),
  ];
  const { g, stats } = build(facts);
  const t = g.nodes.get('table:sys_log');
  assert.deepEqual(t.mpEntities, [fq('ShardingSysLog'), fq('SysLog')]);
  assert.equal(t.mpMappingGrade, 'HEURISTIC', 'one is declared and one derived: the weaker wins');
  assert.equal(stats.tableNameCollisions, 1);
  assert.ok(stats.unresolved.some((u) => u.reason === 'mp-table-claimed-twice'));
});

test('a derived name lands on the CATALOG\'s spelling under the pack\'s identity rule', () => {
  // The defect this pins: jeecg-boot's `sys_user_depart` DDL spells the key
  // `ID` while the entity derives `id`. Keyed by string, that is two nodes for
  // one column and every answer about it is half an answer.
  const catalog = [
    { kind: 'table', schema: null, table: 'shop_order' },
    { kind: 'column', schema: null, table: 'shop_order', column: 'ID' },
  ];
  const facts = [
    type('ShopOrder'), mpEntity('ShopOrder', { fields: [field('id', { id: true })] }),
    type('ShopOrderMapper', { typeKind: 'interface', implements: ['BaseMapper'], implementsArgs: [['ShopOrder']] }),
    mpMapper('ShopOrderMapper', 'ShopOrder'),
    type('Caller'),
    { kind: 'field', owner: fq('Caller'), name: 'm', typeSimple: 'ShopOrderMapper', file: 'Caller.java' },
    call(`${fq('Caller')}#go`, 'm', 'selectById', 'ShopOrderMapper'),
  ];
  const folded = build(facts, { identifierCase: 'fold-lower' }, catalog);
  assert.ok(folded.g.nodes.has('column:shop_order.ID'));
  assert.equal(folded.g.nodes.has('column:shop_order.id'), false);
  assert.deepEqual(edgesFrom(folded.g, `statement:${fq('ShopOrderMapper')}.selectById`)
    .filter((e) => e.type === 'READS').map((e) => e.to), ['column:shop_order.ID']);
  // …and with no rule declared, the two spellings stay two columns, exactly as
  // the SQL bridge would leave them.
  const exact = build(facts, {}, catalog);
  assert.ok(exact.g.nodes.has('column:shop_order.id'));
  assert.ok(exact.g.nodes.has('column:shop_order.ID'));
});

test('an op with no reading is NAMED, not silently dropped', () => {
  const facts = shopFacts().map((f) => (f.kind === 'mpWrapper'
    ? mpWrapper(f.from, {
      entityTypeSimple: 'ShopItem',
      ops: [op('eq', [null, null], [prop('ShopItem', 'getName')]), op('someFutureOp', ['whatever'])],
      sinks: f.sinks,
    })
    : f));
  const { stats } = build(facts);
  assert.deepEqual(stats.opsUninterpreted, { someFutureOp: 1 });
  assert.equal(stats.opsUninterpretedTotal, 1);
  // The op this lane DOES read still produced its column.
  assert.equal(stats.columnsFromMethodReference, 1);
});

test('a `structural` op names no predicate, but the getters inside it still name columns', () => {
  const facts = shopFacts().map((f) => (f.kind === 'mpWrapper'
    ? mpWrapper(f.from, {
      entityTypeSimple: 'ShopItem',
      // `.and(w -> w.eq(ShopItem::getName, x))` — the lambda's body is not a
      // wrapper this scan tracks, but `ShopItem::getName` inside it is
      // unambiguous wherever it appears.
      ops: [op('and', [null], [prop('ShopItem', 'getName')])],
      sinks: f.sinks,
    })
    : f));
  const { g, stats } = build(facts);
  assert.deepEqual(stats.opsStructural, { and: 1 });
  assert.equal(stats.opsUninterpretedTotal, 0);
  assert.ok(edgesFrom(g, `statement:${fq('ShopItemServiceImpl')}.list`)
    .some((e) => e.type === 'READS' && e.to === 'column:shop_item.name'));
});

test('a raw SQL fragment is recorded as unresolved, with the fragment', () => {
  const facts = shopFacts().map((f) => (f.kind === 'mpWrapper'
    ? mpWrapper(f.from, {
      entityTypeSimple: 'ShopItem',
      ops: [op('apply', ['date_format(create_time,\'%Y\') = {0}'])],
      sinks: f.sinks,
    })
    : f));
  const { g, stats } = build(facts);
  assert.equal(stats.sqlFragments, 1);
  assert.equal(stats.fragmentsUnresolved, 1);
  const n = g.nodes.get(`statement:${fq('ShopItemServiceImpl')}.list`);
  const u = n.unresolved.find((x) => x.reason === 'wrapper-sql-fragment');
  assert.ok(u, 'the fragment is KEPT with its reason, not dropped');
  assert.match(u.detail, /date_format/);
  // …and no column was invented from it.
  assert.equal(edgesFrom(g, n.id).some((e) => e.type === 'READS' && /create_time/.test(e.to)), false);
});

test('a wrapper fragment is written into a statement the SQL analyzer can read', () => {
  // The op decides the shape: `apply` is a WHERE, `setSql` an UPDATE ... SET,
  // `inSql` an IN (...), `last` a tail. The FROM is the table the wrapper
  // filters, which is why this needs the entity model and not just the ops.
  const facts = shopFacts().map((f) => (f.kind === 'mpWrapper'
    ? mpWrapper(f.from, {
      entityTypeSimple: 'ShopItem',
      ops: [
        op('apply', ['date_format(create_time,\'%Y\') = {0}']),
        op('inSql', ['id', 'select item_id from shop_order']),
        op('last', ['limit 10']),
      ],
      sinks: f.sinks,
    })
    : f));
  const stmts = wrapperFragmentStatements(facts);
  assert.deepEqual(stmts.map((st) => [st.namespace, st.id, st.type, st.sql]), [
    [fq('ItemController'), 'list#frag0', 'select', 'SELECT 1 FROM shop_item WHERE (date_format(create_time,\'%Y\') = ?)'],
    [fq('ItemController'), 'list#frag1', 'select', 'SELECT 1 FROM shop_item WHERE id IN (select item_id from shop_order)'],
    [fq('ItemController'), 'list#frag2', 'select', 'SELECT 1 FROM shop_item limit 10'],
  ]);
  // `{0}` is MyBatis-Plus's own bind placeholder; without the rewrite every
  // parameterised fragment would come back parse_failed.
  assert.equal(normalizeMpPlaceholders("a = {0} and b = '{1}'"), "a = ? and b = '{1}'");
});

test('setSql becomes an UPDATE, and a wrapper with no entity of its own is NOT written out', () => {
  const setter = shopFacts().map((f) => (f.kind === 'mpWrapper'
    ? mpWrapper(f.from, { entityTypeSimple: 'ShopItem', ops: [op('setSql', ['cost = cost + 1'])], sinks: f.sinks })
    : f));
  assert.deepEqual(wrapperFragmentStatements(setter).map((st) => [st.type, st.sql]),
    [['update', 'UPDATE shop_item SET cost = cost + 1']]);

  // No type argument and no method reference: which table this wrapper filters
  // is decided by the call site, so there is no single FROM to write.
  const unknown = shopFacts().map((f) => (f.kind === 'mpWrapper'
    ? mpWrapper(f.from, { entityTypeSimple: null, ops: [op('apply', ['x = 1'])], sinks: f.sinks })
    : f));
  assert.deepEqual(wrapperFragmentStatements(unknown), []);
  const { g } = build(unknown);
  const n = g.nodes.get(`statement:${fq('ShopItemServiceImpl')}.list`);
  const u = n.unresolved.find((x) => x.reason === 'wrapper-sql-fragment');
  assert.match(u.detail, /no entity of its own/, u.detail);
  assert.match(u.detail, /apply\("x = 1"\)/, u.detail);
});

test('fragment numbering does not depend on where a record landed in the stream', () => {
  // Two wrappers in ONE method. `<method>#frag<n>` must name the same fragment
  // whichever order the fact shards were spliced in, or each fragment would be
  // handed the other's lineage.
  const two = [
    mpWrapper(`${fq('ItemController')}#list`, { var: 'a', line: 5, entityTypeSimple: 'ShopItem', ops: [op('apply', ['a = 1'])] }),
    mpWrapper(`${fq('ItemController')}#list`, { var: 'b', line: 9, entityTypeSimple: 'ShopItem', ops: [op('apply', ['b = 2'])] }),
  ];
  const forward = shopFacts().filter((f) => f.kind !== 'mpWrapper').concat(two);
  const backward = shopFacts().filter((f) => f.kind !== 'mpWrapper').concat([...two].reverse());
  const idsOf = (facts) => wrapperFragmentStatements(facts).map((st) => `${st.id}=${st.sql}`);
  assert.deepEqual(idsOf(forward), idsOf(backward));
  assert.deepEqual(idsOf(forward), [
    'list#frag0=SELECT 1 FROM shop_item WHERE (a = 1)',
    'list#frag1=SELECT 1 FROM shop_item WHERE (b = 2)',
  ]);
  assert.deepEqual([...wrapperFragmentBases(two).values()], [0, 1]);
  assert.deepEqual(wrapperFragments(two[0]).map((f) => f.op), ['apply']);
});

test('the lineage the analyzer returned for a fragment lands on the wrapper\'s statement', () => {
  const facts = shopFacts().map((f) => (f.kind === 'mpWrapper'
    ? mpWrapper(f.from, {
      entityTypeSimple: 'ShopItem',
      ops: [op('apply', ['date_format(create_time,\'%Y\') = {0}']), op('last', ['this is not sql (('])],
      sinks: f.sinks,
    })
    : f));
  // What lineage.py would return for the two statements above: the first
  // resolved, the second unparseable. `create_time` is in the DDL and is NOT a
  // field of ShopItem, so only the fragment can put it on the statement.
  const catalog = [
    { kind: 'table', schema: null, table: 'shop_item' },
    { kind: 'column', schema: null, table: 'shop_item', column: 'create_time' },
    { kind: 'table', schema: null, table: 'shop_order' },
    { kind: 'column', schema: null, table: 'shop_order', column: 'item_id' },
  ];
  const fragmentLineage = [
    {
      kind: 'lineage', namespace: fq('ItemController'), id: 'list#frag0', type: 'select',
      tables: [{ table: 'shop_item', access: 'read' }, { table: 'shop_order', access: 'read' }],
      columns: [
        { table: 'shop_item', column: 'create_time', access: 'read' },
        { table: 'shop_order', column: 'item_id', access: 'read' },
      ],
      joins: [], unresolved: [],
    },
    {
      kind: 'lineage', namespace: fq('ItemController'), id: 'list#frag1', type: 'select',
      tables: [], columns: [], joins: [],
      unresolved: [{ reason: 'parse_failed', detail: 'Invalid expression' }],
    },
  ];
  const { g, stats } = build(facts, { fragmentLineage }, catalog);
  assert.equal(stats.fragmentsResolved, 1);
  assert.equal(stats.fragmentsUnresolved, 1);
  assert.equal(stats.fragmentColumns, 2);

  const sid = `statement:${fq('ShopItemServiceImpl')}.list`;
  const reads = edgesFrom(g, sid).filter((e) => e.type === 'READS');
  const ct = reads.find((e) => e.to === 'column:shop_item.create_time');
  assert.ok(ct, `no READS on create_time; got ${reads.map((e) => e.to).join(', ')}`);
  assert.equal(ct.evidence.fragmentOp, 'apply');
  assert.deepEqual(ct.evidence.roles, ['sql-fragment']);
  assert.equal(ct.grade, 'EXACT', 'ShopItem declares @TableName, and the fragment text is literal SQL');
  // A table only the fragment names gets its own EXECUTES edge, marked as such.
  const other = edgesFrom(g, sid).find((e) => e.type === 'EXECUTES' && e.to === 'table:shop_order');
  assert.ok(other, 'the second table the fragment names is not dropped');
  assert.deepEqual(other.evidence, { access: 'read', via: 'mybatis-plus-fragment', builtin: 'list', fragmentOp: 'apply' });
  // …and the one that did not parse still says so, with its text.
  const u = g.nodes.get(sid).unresolved.find((x) => x.reason === 'wrapper-sql-fragment');
  assert.match(u.detail, /last\("this is not sql \(\("\)/, u.detail);
  assert.match(u.detail, /could not parse it/, u.detail);
});

test('the tables are total: every builtin has an access, every op a reading', () => {
  for (const [m, verb] of Object.entries(MAPPER_BUILTINS)) {
    assert.ok(typeof verb === 'string' && verb.length > 0, `${m} has no verb`);
  }
  for (const [m, verb] of Object.entries(SERVICE_BUILTINS)) {
    assert.ok(typeof verb === 'string' && verb.length > 0, `${m} has no verb`);
  }
  const kinds = new Set(Object.values(OP_KINDS));
  assert.deepEqual([...kinds].sort(), ['column', 'columns', 'sql', 'structural', 'write']);
  // The methods that run NO SQL must not be statements.
  for (const m of ['getBaseMapper', 'lambdaQuery', 'lambdaUpdate', 'query']) {
    assert.equal(Object.hasOwn(SERVICE_BUILTINS, m), false, `${m} runs no statement`);
  }
});

test('a bad naming strategy fails closed instead of falling back', () => {
  assert.throws(() => build(shopFacts(), { namingStrategy: 'camelCase' }), /mybatisPlus.namingStrategy/);
});

test('a project with no MyBatis-Plus pays nothing', () => {
  const { g, stats } = build([type('Plain'), { kind: 'field', owner: fq('Plain'), name: 'x', typeSimple: 'String', file: 'Plain.java' }]);
  assert.equal(stats.entities, 0);
  assert.equal(stats.statements, 0);
  assert.equal([...g.nodes.values()].filter((n) => n.kind === 'table').length, 0);
});
