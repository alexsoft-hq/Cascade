// mp_worker.test.mjs — what adapters/java/JavaFacts.java RECORDS about
// MyBatis-Plus (javafacts/6), read back off real compiled-and-run output.
//
// The bridge's own tests (test/mp_bridge.test.mjs) feed it hand-written records.
// This one closes the other half of the loop: that the WORKER, walking a real
// parse tree, produces those records from source that looks like a MyBatis-Plus
// project's. Without it the two halves could agree on a record shape neither
// side ever sees.
//
// The worker decides NOTHING here, and the assertions say so: `eq` is recorded
// as the op named `eq`, `SysUserDepart::getDepId` as a method reference whose
// JavaBeans property is `depId`, and `QueryGenerator.initQueryWrapper` as the
// name of whatever built a wrapper this scan cannot see through. What any of it
// MEANS is src/adapters/mp_bridge.mjs's reading (I-1/I-6).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findJdk } from '../scripts/ci-java-smoke.mjs';
import { JAVA_WORKER_VERSION } from '../src/core/worker_versions.mjs';
import { javaRecordSortKey, splitJavaFactsByFile, assembleJavaFacts } from '../src/core/facts_store.mjs';

const ENGINE_ROOT = fileURLToPath(new URL('../', import.meta.url));

/**
 * One file, written the way a MyBatis-Plus project writes one. Every construct
 * in it is one the fixture jeecg-boot uses; the counts asserted below were
 * derived by reading THIS source, not by running the worker first.
 */
const SOURCES = {
  'Item.java': `package shop;
import com.baomidou.mybatisplus.annotation.*;
@TableName("shop_item")
public class Item {
    private static final long serialVersionUID = 1L;
    @TableId(type = IdType.ASSIGN_ID)
    private String id;
    private String itemName;
    @TableField("cost")
    private java.math.BigDecimal price;
    @TableLogic
    private Integer delFlag;
    @Version
    private Integer revision;
    @TableField(exist = false)
    private String formatted;
    private transient String scratch;
    public String getItemName() { return itemName; }
    public Integer getDelFlag() { return delFlag; }
}
`,
  'Order.java': `package shop;
public class Order {
    private String id;
    private String orderCode;
}
`,
  'ItemMapper.java': `package shop;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
public interface ItemMapper extends BaseMapper<Item> {
}
`,
  'IItemService.java': `package shop;
import com.baomidou.mybatisplus.extension.service.IService;
public interface IItemService extends IService<Item> {
}
`,
  'ItemServiceImpl.java': `package shop;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.baomidou.mybatisplus.extension.service.impl.ServiceImpl;
import java.util.List;
public class ItemServiceImpl extends ServiceImpl<ItemMapper, Item> implements IItemService {
    private OrderMapper orderMapper;

    public List<Item> byName(String n) {
        LambdaQueryWrapper<Item> q = new LambdaQueryWrapper<>();
        q.eq(Item::getItemName, n);
        q.orderByDesc("cost");
        return baseMapper.selectList(q);
    }

    public long countCheap() {
        return this.count(new QueryWrapper<Item>().lt("cost", 10));
    }

    public Item one(String code) {
        return getOne(Wrappers.<Item>lambdaQuery().eq(Item::getDelFlag, 0));
    }

    public List<Item> fromCaller(QueryWrapper<Item> given) {
        given.eq("id", "x");
        return list(given);
    }
}
`,
  'OrderMapper.java': `package shop;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
public interface OrderMapper extends BaseMapper<Order> {
}
`,
  'ItemController.java': `package shop;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import java.util.List;
public class ItemController {
    private IItemService service;

    public List<Item> list(Object request) {
        QueryWrapper<Item> queryWrapper = QueryGenerator.initQueryWrapper(new Item(), request);
        return service.list(queryWrapper);
    }
}
`,
  'QueryGenerator.java': `package shop;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
public class QueryGenerator {
    public static <T> QueryWrapper<T> initQueryWrapper(T o, Object params) { return new QueryWrapper<T>(); }
}
`,
};

function runWorker(jdk, dir) {
  const buildDir = path.join(dir, 'classes');
  fs.mkdirSync(buildDir, { recursive: true });
  execFileSync(jdk.javac, ['-d', buildDir, path.join(ENGINE_ROOT, 'adapters', 'java', 'JavaFacts.java')],
    { stdio: ['ignore', 'ignore', 'inherit'] });
  const src = path.join(dir, 'src');
  const out = execFileSync(jdk.java, ['-cp', buildDir, 'JavaFacts', '--root', src, src], { maxBuffer: 1 << 26 })
    .toString('utf8');
  return out.split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
}

test('javafacts/6 records MyBatis-Plus evidence, and decides nothing', (t) => {
  const jdk = findJdk();
  if (!jdk) {
    t.skip('no JDK found: JAVA_HOME is unset and no javac on PATH — see docs/setup/java-lane.md');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-mp-worker-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const src = path.join(dir, 'src', 'shop');
  fs.mkdirSync(src, { recursive: true });
  for (const [name, text] of Object.entries(SOURCES)) fs.writeFileSync(path.join(src, name), text, 'utf8');

  const records = runWorker(jdk, dir);
  const header = records[0];
  assert.equal(header.kind, 'header');
  assert.equal(header.version, JAVA_WORKER_VERSION);
  assert.equal(header.parseErrors, 0);
  const of = (kind) => records.filter((r) => r.kind === kind);

  // ---- mpEntity: the annotations, verbatim ------------------------------
  // TWO classes carry MP field annotations or @TableName: Item does; Order does
  // NOT — no annotation anywhere in it — so no record is emitted for it, and it
  // is the BRIDGE that then decides Order is an entity because OrderMapper names
  // it. Emitting one here would need to read another file, and the fact cache
  // shards this stream by file.
  const entities = of('mpEntity');
  assert.deepEqual(entities.map((e) => e.fqn), ['shop.Item']);
  const item = entities[0];
  assert.equal(item.tableName, 'shop_item');
  assert.equal(item.tableNameDeclared, true);
  assert.equal(item.schema, null);
  const byName = Object.fromEntries(item.fields.map((f) => [f.name, f]));
  assert.deepEqual(Object.keys(byName).sort(),
    ['delFlag', 'formatted', 'id', 'itemName', 'price', 'revision', 'scratch', 'serialVersionUID']);
  assert.equal(byName.serialVersionUID.static, true);
  assert.equal(byName.scratch.transient, true);
  assert.equal(byName.formatted.exist, false);
  assert.equal(byName.id.id, true);
  assert.equal(byName.id.idType, 'ASSIGN_ID');
  assert.equal(byName.price.column, 'cost');
  assert.equal(byName.itemName.column, null, 'an unannotated field names no column HERE — the rule is the bridge\'s');
  assert.equal(byName.delFlag.logic, true);
  assert.equal(byName.revision.version, true);

  // ---- mpMapper / mpService: the generic bases, with their arguments -----
  assert.deepEqual(of('mpMapper').map((r) => [r.fqn, r.base, r.entityTypeSimple]).sort(),
    [['shop.ItemMapper', 'BaseMapper', 'Item'], ['shop.OrderMapper', 'BaseMapper', 'Order']]);
  assert.deepEqual(of('mpService').map((r) => [r.fqn, r.base, r.mapperTypeSimple, r.entityTypeSimple]).sort(),
    [
      ['shop.IItemService', 'IService', null, 'Item'],
      ['shop.ItemServiceImpl', 'ServiceImpl', 'ItemMapper', 'Item'],
    ]);

  // ---- ServiceImpl's inherited `baseMapper` field resolves ---------------
  // `baseMapper.selectList(q)` is declared in ServiceImpl<M, T>, not here; the
  // `extends ServiceImpl<ItemMapper, Item>` clause IS in this file and names M,
  // so the receiver's declared type is read off it. No `field` record is emitted
  // for it — this type does not declare the field.
  const bm = of('call').filter((c) => c.receiver === 'baseMapper');
  assert.deepEqual(bm.map((c) => [c.from, c.method, c.toTypeSimple]),
    [['shop.ItemServiceImpl#byName', 'selectList', 'ItemMapper']]);
  assert.equal(of('field').some((f) => f.name === 'baseMapper'), false,
    'the worker must not claim a field this file does not declare');

  // ---- mpWrapper: six wrappers, one per way of building one -------------
  // Five in the code under test, plus the `new QueryWrapper<T>()` inside the
  // helper QueryGenerator itself — the scan reads every method body, including
  // the ones that MAKE wrappers for somebody else.
  const wrappers = of('mpWrapper');
  assert.deepEqual(wrappers.map((w) => `${w.from}@${w.line}`).sort(), [
    'shop.ItemController#list@8',
    'shop.ItemServiceImpl#byName@11',
    'shop.ItemServiceImpl#countCheap@18',
    'shop.ItemServiceImpl#fromCaller@25',
    'shop.ItemServiceImpl#one@22',
    'shop.QueryGenerator#initQueryWrapper@4',
  ]);

  // (a) a local `new LambdaQueryWrapper<>()` whose entity comes from the
  //     DECLARED type argument, with two ops and a mapper sink.
  const a = wrappers.find((w) => w.var === 'q');
  assert.equal(a.wrapperKind, 'lambda-query');
  assert.equal(a.entityTypeSimple, 'Item');
  assert.equal(a.origin, 'new');
  assert.equal(a.opsComplete, true);
  assert.deepEqual(a.ops.map((o) => o.name), ['eq', 'orderByDesc']);
  assert.deepEqual(a.ops[0].props, [{ owner: 'Item', method: 'getItemName', property: 'itemName' }]);
  assert.deepEqual(a.ops[0].args, [null, null]);
  assert.deepEqual(a.ops[1].args, ['cost'], 'a string literal is recorded as written; which position is a column is the bridge\'s reading');
  assert.deepEqual(a.sinks, [{ kind: 'field', receiver: 'baseMapper', receiverTypeSimple: 'ItemMapper', method: 'selectList', line: a.sinks[0].line }]);

  // (b) an INLINE `new QueryWrapper<Item>().lt(...)` passed straight to
  //     `this.count(...)` — no variable at all.
  const b = wrappers.find((w) => w.from.endsWith('#countCheap'));
  assert.equal(b.var, null);
  assert.equal(b.wrapperKind, 'query');
  assert.equal(b.entityTypeSimple, 'Item');
  assert.deepEqual(b.ops.map((o) => [o.name, o.args]), [['lt', ['cost', null]]]);
  assert.deepEqual(b.sinks.map((s) => [s.kind, s.receiver, s.method]), [['this', 'this', 'count']]);

  // (c) the static factory, with an explicit type witness, into an UNQUALIFIED
  //     call — the receiver is the enclosing type.
  const c = wrappers.find((w) => w.from.endsWith('#one'));
  assert.equal(c.origin, 'factory');
  assert.equal(c.wrapperKind, 'lambda-query');
  assert.equal(c.entityTypeSimple, 'Item');
  assert.deepEqual(c.ops[0].props, [{ owner: 'Item', method: 'getDelFlag', property: 'delFlag' }]);
  assert.deepEqual(c.sinks.map((s) => [s.kind, s.method]), [['this', 'getOne']]);

  // (d) a wrapper this method RECEIVES: its caller's ops are not in this file,
  //     and `opsComplete:false` is the whole disclosure.
  const d = wrappers.find((w) => w.origin === 'parameter');
  assert.equal(d.var, 'given');
  assert.equal(d.opsComplete, false);
  assert.equal(d.entityTypeSimple, 'Item');
  assert.deepEqual(d.ops.map((o) => o.name), ['eq'], 'the ops added HERE are still recorded');

  // (e) a wrapper built by a helper this lane cannot see through: the name of
  //     whatever built it is recorded rather than the conditions guessed.
  const e = wrappers.find((w) => w.origin === 'opaque-initializer');
  assert.equal(e.builtBy, 'QueryGenerator.initQueryWrapper');
  assert.equal(e.opsComplete, false);
  assert.equal(e.entityTypeSimple, 'Item');
  assert.deepEqual(e.ops, []);
  assert.deepEqual(e.sinks.map((s) => [s.kind, s.receiver, s.receiverTypeSimple, s.method]),
    [['field', 'service', 'IItemService', 'list']]);

  // (f) the helper's own `new QueryWrapper<T>()`: its entity argument is the
  //     method's TYPE PARAMETER, recorded as written. `T` means nothing until
  //     something binds it, and the worker says `T` rather than inventing a
  //     class — the bridge resolves it against the statement it feeds, or
  //     reports that it could not.
  const f = wrappers.find((w) => w.from.startsWith('shop.QueryGenerator#'));
  assert.equal(f.entityTypeSimple, 'T');
  assert.deepEqual(f.ops, []);
  assert.deepEqual(f.sinks.map((s) => s.kind), ['returned']);

  // ---- every record rides in a file shard, in the worker's own order -----
  // A record without a `file` would be silently dropped from the fact cache;
  // one whose sort key core does not reproduce would make an incremental run and
  // a cold run assemble different bytes (SPEC §17.7, I-9).
  for (const r of records.slice(1)) {
    assert.ok(typeof r.file === 'string' && r.file.length > 0, `${r.kind} record carries no file`);
    assert.ok(javaRecordSortKey(r) !== null, `core does not know the sort key of a ${r.kind} record`);
  }
  const { skipped } = splitJavaFactsByFile(records);
  assert.equal(skipped, 1, 'only the header is not shard content');
  const reassembled = assembleJavaFacts(splitJavaFactsByFile(records).byFile);
  assert.deepEqual(reassembled.map((r) => JSON.stringify(r)), records.slice(1).map((r) => JSON.stringify(r)),
    'the shards reassemble into the worker\'s own stream, byte for byte');
});
