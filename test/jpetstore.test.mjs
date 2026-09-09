// jpetstore.test.mjs — the SQL lane end to end over a second real project.
//
// mall is the large fixture; this is the small one, and it is here for a
// different reason. Every count below was read out of the FIXTURE — the DDL
// file, the mapper XML, the controller annotations — and never out of this
// engine's output, so the test scores the engine against the source rather than
// against itself. The command that produced each number is recorded beside it.
//
// WHAT THIS FIXTURE ACTUALLY IS. mybatis/jpetstore-6 at the pinned commit is
// Spring MVC + MyBatis XML: five `@Controller` classes with `@RequestMapping` on
// the class and `@GetMapping`/`@PostMapping` on 22 methods. (It was a Stripes
// application in earlier releases; it is not one here, and the endpoint counts
// below are the evidence.) Its schema is HSQLDB, not MySQL — lower-case
// `create table`, no backticks, and a NAMED `constraint pk_x primary key (…)`
// on every table.
//
// AND WHAT IT EXPOSES. Its SQL is written in UPPER CASE (`FROM ITEM I, PRODUCT
// P`) while its DDL declares the tables in lower case. Until RM12 this engine
// matched identifiers by exact string, so the two never met: the catalog's
// `item` and the statements' `ITEM` became two different tables in one pack,
// and every read rode on the wrong one. RM12 made identifier identity a
// DECLARED, per-dialect rule (`sqlIdentifierCase`, src/core/identifier_case.mjs
// and its mirror adapters/sql/identifier_case.py), so the two now meet on a
// folded MATCHING KEY while every name printed below is still the one the DDL
// declared. The second test in this file measures the before/after.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadPack } from '../src/core/pack.mjs';
import { callTool } from '../src/mcp/catalog.mjs';
import { computeTrust } from '../src/core/trust.mjs';
import { findJdk } from '../scripts/ci-java-smoke.mjs';

const ENGINE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const CLI = path.join(ENGINE_ROOT, 'bin', 'cascade.mjs');
const VENV_PY = path.join(ENGINE_ROOT, '.venv', 'bin', 'python');

/**
 * The pinned commit. The counts below describe the source AT THIS COMMIT.
 * mybatis/jpetstore-6, 2026-09-02.
 */
const PINNED_COMMIT = 'ebb36b392f0c0fdec10e2e7b364b03b88c08c184';

const FIXTURE = process.env.CASCADE_JPETSTORE
  ?? path.resolve(ENGINE_ROOT, '..', 'target-examples', 'jpetstore-6');

const DDL_REL = 'src/main/resources/database/jpetstore-hsqldb-schema.sql';
const MAPPERS_REL = 'src/main/resources/org/mybatis/jpetstore/mapper';
const SRC_REL = 'src/main/java';

function preflight() {
  if (!fs.existsSync(path.join(FIXTURE, DDL_REL))) {
    return `no jpetstore-6 checkout at ${FIXTURE} — clone it at ${PINNED_COMMIT} `
      + '(git clone https://github.com/mybatis/jpetstore-6) or set CASCADE_JPETSTORE';
  }
  if (!fs.existsSync(VENV_PY)) return `no venv python at ${VENV_PY} (see docs/setup/sql-lane.md)`;
  if (!findJdk()) return 'no JDK found: JAVA_HOME is unset and no javac on PATH (see docs/setup/java-lane.md)';
  return null;
}

function askOf(packDir) {
  const pack = JSON.parse(fs.readFileSync(path.join(packDir, 'pack.json'), 'utf8'));
  const graph = loadPack(pack, { verifyDigest: true });
  const ctx = {
    graph,
    basis: { project: pack.meta.project, buildDigest: pack.digest, builtAt: pack.meta.builtAt, freshness: { verdict: 'unknown' } },
    trust: computeTrust({}),
    limits: [],
    pack: {
      project: pack.meta.project, digest: pack.digest, builtAt: pack.meta.builtAt,
      lanes: pack.meta.lanes, base: pack.meta.base, axes: pack.meta.axes, laneStats: pack.meta.laneStats,
      // The identity rule the pack RECORDS, exactly as `packMeta()` in
      // bin/cascade.mjs hands it to the server — this is what lets a tool
      // argument be resolved the way the analyzer resolved the same spelling.
      identifierCase: pack.meta.identifierCase ?? null,
    },
    profile: null,
  };
  return { pack, graph, ask: (name, args) => callTool(name, args, ctx) };
}

test('mybatis/jpetstore-6: the SQL lane end to end, and the partial-pack contract', { timeout: 900000 }, (t) => {
  const why = preflight();
  if (why) { t.skip(why); return; }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-jpetstore-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const repo = path.join(work, 'repo');
  execFileSync('git', ['clone', '--quiet', '--no-hardlinks', FIXTURE, repo], { stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['-C', repo, 'checkout', '--quiet', PINNED_COMMIT], { stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD']).toString('utf8').trim(), PINNED_COMMIT);

  const cli = (args) => spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    env: { ...process.env, XDG_CACHE_HOME: path.join(work, 'cache'), CASCADE_HOME: path.join(work, 'home') },
  });

  const init = cli(['init', '--root', repo, '--project', 'jpetstore']);
  assert.equal(init.status, 0, init.stderr);
  // The tree carries TWO files with CREATE TABLE (the schema and the data-load
  // script), so `init` refuses to pick one and leaves catalog.source "none",
  // saying which two it found. That is why --ddl is passed below.
  assert.match(init.stderr, /AMBIGUOUS_CATALOG_SOURCE/, init.stderr);
  const profile = JSON.parse(fs.readFileSync(path.join(repo, '.cascade', 'profile.json'), 'utf8'));
  assert.equal(profile.catalog.source, 'none');
  assert.deepEqual(profile.frameworkPacks.sort(), ['mybatis-xml', 'spring-mvc']);

  const analyze = cli([
    'analyze', '--root', repo, '--project', 'jpetstore',
    '--ddl', path.join(repo, DDL_REL),
    '--mappers', path.join(repo, MAPPERS_REL),
    '--java-src', path.join(repo, SRC_REL),
  ]);
  assert.equal(analyze.status, 0, analyze.stderr);

  // -----------------------------------------------------------------------
  // 1. the catalog, hand-counted from the DDL.
  //    $ grep -ci 'create table' src/main/resources/database/jpetstore-hsqldb-schema.sql
  //      -> 13
  //    The 13: supplier signon account profile bannerdata orders orderstatus
  //    lineitem category product item inventory sequence.
  //    86 columns is the sum of their column lines; the worker prints both.
  // -----------------------------------------------------------------------
  assert.match(analyze.stderr, /"tables":13/, analyze.stderr);
  assert.match(analyze.stderr, /"columns":86/, analyze.stderr);
  // HSQLDB syntax parses without a single warning: lower-case `create table`,
  // no backticks, `decimal(10,2)`, and a named PK constraint per table.
  assert.match(analyze.stderr, /"version":"catalog-ddl\/3","warnings":0/, analyze.stderr);

  // -----------------------------------------------------------------------
  // 2. the statements, hand-counted from the mapper XML.
  //    $ cd src/main/resources/org/mybatis/jpetstore/mapper
  //    $ grep -ohE '<(select|insert|update|delete)\b' *.xml | wc -l
  //      -> 25   over 7 files (Account 8, Category 2, Item 4, LineItem 2,
  //              Order 4, Product 3, Sequence 2)
  // -----------------------------------------------------------------------
  assert.match(analyze.stderr, /"files":7,"fragments":0/, analyze.stderr);
  assert.match(analyze.stderr, /"statements":25/, analyze.stderr);

  // -----------------------------------------------------------------------
  // 2b. the identity rule this run matched names with, stated out loud. The
  //     profile `init` wrote declares no dialect, so the lane assumed mysql and
  //     mysql's declared rule is fold-lower. The fixture is HSQLDB, whose rule
  //     is fold-UPPER — and the result below is the same either way, because
  //     the fold only decides what MATCHES; the name every answer prints comes
  //     from the catalog. (The equality of the two is measured in the second
  //     test.) No catalog name folds onto another, so: zero collisions.
  // -----------------------------------------------------------------------
  assert.match(analyze.stderr, /"identifierCase":"fold-lower"/, analyze.stderr);
  assert.match(analyze.stderr, /"identifierCollisions":0/, analyze.stderr);

  const { pack, graph, ask } = askOf(path.join(repo, '.cascade', 'pack'));
  assert.equal(pack.meta.base.commit, PINNED_COMMIT);
  // ...and the WEB lane, which this project has without a line of JavaScript
  // (RM48): its screens are the JSP pages a `@Controller` names.
  assert.deepEqual(pack.meta.lanes, ['sql', 'java', 'web']);

  // -----------------------------------------------------------------------
  // 3. the endpoints, hand-counted from the controllers.
  //    $ cd src/main/java/org/mybatis/jpetstore/web/controllers
  //    $ grep -c '@GetMapping\|@PostMapping' *.java
  //      Account 7, Cart 5, Catalog 5, Order 4, Root 1  -> 22
  //    Three of them are @GetMapping({ "", "/" }) — two spellings of ONE route
  //    under the class's @RequestMapping, which is why 22 annotations give 22
  //    endpoints and not 25.
  //
  //    THIS IS THE FIXTURE'S CURRENT SHAPE. jpetstore-6 was a Stripes
  //    application in earlier releases; at this commit it is Spring MVC, so the
  //    endpoint axis IS shipped here and the Java lane really walks it.
  // -----------------------------------------------------------------------
  // The routes this pack SERVES. A page's link to something it does not serve
  // is an OUTBOUND node (RM48) and is asserted on its own below.
  const endpoints = [...graph.nodes.values()]
    .filter((n) => n.kind === 'endpoint' && n.outbound !== true)
    .map((n) => n.id.slice('endpoint:'.length)).sort();
  assert.deepEqual(endpoints, [
    'GET /',                        // RootController
    'GET /account',                 // AccountController @GetMapping({"", "/"})
    'GET /account/edit',
    'GET /account/new',
    'GET /account/signoff',
    'GET /cart',                    // CartController @GetMapping({"", "/"})
    'GET /cart/addItem',
    'GET /cart/checkout',
    'GET /cart/removeItem',
    'GET /catalog',                 // CatalogController @GetMapping({"", "/"})
    'GET /catalog/searchProducts',
    'GET /catalog/viewCategory',
    'GET /catalog/viewItem',
    'GET /catalog/viewProduct',
    'GET /order/list',
    'GET /order/new',
    'GET /order/view',
    'POST /account/edit',
    'POST /account/new',
    'POST /account/signon',
    'POST /cart/update',
    'POST /order/new',
  ]);
  assert.equal(pack.meta.laneStats.endpoints, 22);
  // ...and the two the JSP pages point at and no controller answers: the
  // container serves them as files. They are nodes marked `outbound`, exactly
  // as a call that leaves the pack is, never silently dropped.
  assert.deepEqual(
    [...graph.nodes.values()].filter((n) => n.kind === 'endpoint' && n.outbound === true)
      .map((n) => n.id.slice('endpoint:'.length)).sort(),
    ['GET /help.html', 'GET /index.html'],
  );
  assert.equal(pack.meta.laneStats.parseErrors, 0, 'the fixture parses cleanly');
  // Every mapper method the Java lane saw is bound to a statement in this pack.
  assert.equal(pack.meta.laneStats.mapperMethods, 25);
  assert.equal(pack.meta.laneStats.unboundMapperMethods, 0);

  // -----------------------------------------------------------------------
  // 4. the partial-pack contract: what this pack does NOT carry, declared.
  //    The fixture has no @Entity, so the JPA bridge did not run. The web and
  //    screen axes DO ship here since RM48, without a line of JavaScript: every
  //    screen this application has is a JSP file a `@Controller` named, and
  //    every one of its 22 handler returns is a name this engine could read.
  // -----------------------------------------------------------------------
  assert.equal(pack.meta.axes.catalog.status, 'shipped');
  assert.equal(pack.meta.axes.statements.status, 'shipped');
  assert.equal(pack.meta.axes.column.status, 'shipped');
  assert.equal(pack.meta.axes.code.status, 'shipped');
  assert.equal(pack.meta.axes.jpa.status, 'not-shipped');
  assert.equal(pack.meta.axes.web.status, 'shipped');
  assert.equal(pack.meta.axes.screen.status, 'shipped');
  const gaps = ask('overview', {}).trust.knownGaps;
  for (const g of ['jpa-axis-not-shipped']) {
    assert.ok(gaps.includes(g), `${g} must be declared on every answer; got ${gaps.join(',')}`);
  }
  // The pages themselves: a screen per view name, keyed apart from a router's
  // screens by the `view:` prefix. Ten of the sixteen are named by a `static
  // final String` the controller declares, not by a literal at the return.
  const pages = [...graph.nodes.values()].filter((n) => n.kind === 'screen').map((n) => n.name).sort();
  assert.deepEqual(pages, [
    'account/EditAccountForm', 'account/NewAccountForm', 'account/SignonForm',
    'cart/Cart', 'cart/Checkout', 'catalog/Category', 'catalog/Item',
    'catalog/Main', 'catalog/Product', 'catalog/SearchProducts', 'common/Error',
    'order/ConfirmOrder', 'order/ListOrders', 'order/NewOrderForm',
    'order/ShippingForm', 'order/ViewOrder',
  ]);
  const byFrom = {};
  for (const e of graph.edges.filter((x) => x.type === 'RENDERS_PAGE')) {
    byFrom[e.evidence.from] = (byFrom[e.evidence.from] ?? 0) + 1;
  }
  assert.deepEqual(byFrom, { constant: 17, literal: 10 });
  // The header every page pulls in is one row on each of the sixteen, and never
  // a screen of its own.
  const top = graph.edges.filter((e) => e.type === 'RENDERS'
    && e.to === 'symbol:src/main/webapp/WEB-INF/jsp/common/IncludeTop.jsp');
  assert.equal(top.length, 16);
  assert.equal(graph.nodes.has('screen:view:common/IncludeTop'), false);

  // -----------------------------------------------------------------------
  // SPOT CHECK 1 — table_usage on the orders table.
  //    OrderMapper.xml names ORDERS in exactly three statements, readable at
  //    lines 54, 87 and 94:
  //      getOrder            SELECT ... FROM ORDERS, ORDERSTATUS   -> read
  //      getOrdersByUsername SELECT ... FROM ORDERS, ORDERSTATUS   -> read
  //      insertOrder         INSERT INTO ORDERS (...)              -> write
  //    (insertOrderStatus writes ORDERSTATUS, a different table.)
  //
  //    THE STORED KEY IS THE CATALOG'S SPELLING, `orders` — that is RM12's
  //    fix: one node per table, named the way the schema declares it. RM13
  //    finishes the job on the ARGUMENT side: `ORDERS`, the spelling the SQL
  //    uses, is folded onto the stored name under the rule the pack records
  //    (`meta.identifierCase` = fold-lower here), the two calls return the same
  //    statements, and the folded one SAYS so in `limits` — an answer about a
  //    name other than the one that was typed is never silent.
  // -----------------------------------------------------------------------
  const expectedOrderStatements = [
    ['OrderMapper.getOrder', 'read'],
    ['OrderMapper.getOrdersByUsername', 'read'],
    ['OrderMapper.insertOrder', 'write'],
  ];
  assert.equal(pack.meta.identifierCase, 'fold-lower');
  const usage = ask('table_usage', { table: 'orders' });
  assert.deepEqual(
    usage.answer.statements.map((s) => [s.id.replace('org.mybatis.jpetstore.mapper.', ''), s.access]).sort(),
    expectedOrderStatements,
  );
  assert.equal(usage.limits.filter((l) => l.scope === 'identifier-case').length, 0);

  const upper = ask('table_usage', { table: 'ORDERS' });
  assert.deepEqual(upper.answer.statements, usage.answer.statements);
  assert.deepEqual(upper.answer.columns, usage.answer.columns);
  const fold = upper.limits.find((l) => l.scope === 'identifier-case');
  assert.ok(fold, JSON.stringify(upper.limits));
  assert.match(fold.reason, /"ORDERS"/);
  assert.match(fold.reason, /"orders"/);
  assert.match(fold.reason, /fold-lower/);

  // A name the pack really does not hold still fails — with the nearest one.
  assert.throws(() => ask('table_usage', { table: 'ordrs' }), /table not found in pack: ordrs\. Did you mean orders\?/);

  // -----------------------------------------------------------------------
  // SPOT CHECK 2 — erd. This engine never reads foreign keys: a relationship
  // here is an equi-join the mapper SQL WITNESSES. The DDL's three foreign keys
  // (fk_product_1 product->category, fk_item_1 item->product, fk_item_2
  // item->supplier) are therefore not the expected set — the mappers' join
  // predicates are, and there are exactly eleven of them:
  //
  //    $ cd src/main/resources/org/mybatis/jpetstore/mapper
  //    $ grep -cE '^\s*(AND|WHERE)\s+[A-Z]+\.[A-Z]+\s*=\s*[A-Z]+\.[A-Z]+' *.xml
  //      AccountMapper 6  (lines 47,48,49 and 74,75,76 — the same three
  //                        predicates in getAccountByUsername and
  //                        getAccountByUsernameAndPassword)
  //      ItemMapper    3  (43: P.PRODUCTID=I.PRODUCTID;
  //                        65,66: P.PRODUCTID=I.PRODUCTID, I.ITEMID=V.ITEMID)
  //      OrderMapper   2  (56 and 89: ORDERS.ORDERID=ORDERSTATUS.ORDERID)
  //      -> 11 predicates over 6 DISTINCT table pairs, which is what the ERD
  //         reports (one edge per pair, `statements` counting the witnesses).
  //    Aliases: I=ITEM, P=PRODUCT, V=INVENTORY (ItemMapper.xml lines 43, 65).
  //    Only ONE of the three declared foreign keys (item->product) is among
  //    them; the SQL never joins on the other two.
  // -----------------------------------------------------------------------
  const erd = ask('erd', {});
  assert.deepEqual(
    erd.answer.relationships.map((r) => [r.from, r.to, r.columns.join(','), r.statements]),
    [
      ['account', 'profile', 'userid=userid', 2],
      ['account', 'signon', 'userid=username', 2],
      ['bannerdata', 'profile', 'favcategory=favcategory', 2],
      ['inventory', 'item', 'itemid=itemid', 1],
      ['item', 'product', 'productid=productid', 2],
      ['orders', 'orderstatus', 'orderid=orderid', 2],
    ],
  );
  // 13 tables, not 25: one node per declared table (see the second test).
  assert.equal(erd.answer.tables.length, 13);

  // -----------------------------------------------------------------------
  // SPOT CHECK 3 — column_impact on item.listprice.
  //    ItemMapper.xml reads LISTPRICE in TWO statements (getItemListByProduct
  //    at line 26, getItem at line 47):
  //    $ grep -n 'LISTPRICE' ItemMapper.xml   -> lines 29 and 50, one inside
  //      each of those two <select> bodies.
  //    The honest answer is "two reading statements", and it is what comes back
  //    now. Before RM12 the engine answered "none": the reads had landed on the
  //    invented upper-case `ITEM.LISTPRICE` instead.
  // -----------------------------------------------------------------------
  const ci = ask('column_impact', { column: 'item.listprice' });
  assert.equal(ci.answer.type, 'DECIMAL(10, 2)', 'the catalog column itself is read correctly');
  assert.deepEqual(
    ci.answer.statements.map((x) => [x.id.replace('org.mybatis.jpetstore.mapper.', ''), x.access, x.grade]),
    [['ItemMapper.getItem', 'read', 'EXACT'], ['ItemMapper.getItemListByProduct', 'read', 'EXACT']],
  );
  assert.equal(ci.answer.empty, undefined, 'nothing about this column is empty any more');
});

test('mybatis/jpetstore-6: FIXED — one identity per table, whatever the SQL spells', { timeout: 900000 }, (t) => {
  const why = preflight();
  if (why) { t.skip(why); return; }

  // WHAT WAS WRONG (M11 measured it here and pinned it as a KNOWN DEFECT). The
  // DDL declares `create table item (...)`; the mapper SQL says `FROM ITEM I`.
  // The lineage worker was handed the catalog as a schema and matched by exact
  // string, so qualification failed on twelve of the twenty-five statements and
  // the pack ended up with TWO of every table the SQL touches: the catalog's
  // lower-case one and a stub named in upper case.
  //
  // WHAT FIXED IT (RM12). Identifier identity is now a DECLARED, per-dialect
  // rule. The catalog is indexed by a folded MATCHING KEY next to the spelling
  // it was declared with; a reference resolves through the key and every fact is
  // emitted under the declared spelling. Nothing is renamed, and nothing is
  // matched loosely: a table the catalog does not have under the folded
  // comparison is still `unresolved`.
  //
  // THE MEASUREMENT, run against this very fixture, same 25 statements, same
  // worker, the ONLY difference being --identifier-case:
  //
  //                          exact (the old behaviour)   fold-lower   fold-upper
  //   column facts                          53               231          231
  //   unresolved column refs               180                 1            1
  //   unresolvedRate                    0.7725            0.0043       0.0043
  //   join facts                             0                11           11
  //   qualify_failed diagnostics            12                 0            0
  //   tables in the pack                    25                13           13
  //   READS edges                            0               160          160
  //
  // fold-lower and fold-upper give the IDENTICAL result (the two output streams
  // are byte-for-byte equal): the fold direction decides only what matches, and
  // the printed name always comes from the catalog. That is the property that
  // makes this safe to default per dialect.
  //
  // The one column reference that is still unresolved is honest: `ORDER BY
  // ORDERDATE` in getOrdersByUsername (OrderMapper.xml line 90) is a bare column
  // with two tables — ORDERS and ORDERSTATUS — in scope, so §3.3 files it under
  // `unqualified_column` rather than guessing which one owns it.

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-jpetstore-case-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const repo = path.join(work, 'repo');
  execFileSync('git', ['clone', '--quiet', '--no-hardlinks', FIXTURE, repo], { stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['-C', repo, 'checkout', '--quiet', PINNED_COMMIT], { stdio: ['ignore', 'pipe', 'pipe'] });

  const cli = (args) => spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    env: { ...process.env, XDG_CACHE_HOME: path.join(work, 'cache'), CASCADE_HOME: path.join(work, 'home') },
  });
  assert.equal(cli(['init', '--root', repo, '--project', 'jpetstore']).status, 0);
  const analyze = cli([
    'analyze', '--root', repo, '--project', 'jpetstore',
    '--ddl', path.join(repo, DDL_REL),
    '--mappers', path.join(repo, MAPPERS_REL),
    '--java-src', path.join(repo, SRC_REL),
  ]);
  assert.equal(analyze.status, 0, analyze.stderr);
  assert.match(analyze.stderr, /"columnFacts":231,.*"unresolvedRate":0\.0043/, analyze.stderr);
  assert.match(analyze.stderr, /"joinFacts":11/, analyze.stderr);
  assert.match(analyze.stderr, /"unresolvedColumns":1/, analyze.stderr);
  assert.match(analyze.stderr, /"unresolvedJoins":0/, analyze.stderr);

  const { graph } = askOf(path.join(repo, '.cascade', 'pack'));
  // 13 catalog tables and NOT ONE MORE: no upper-case twin, no stub.
  const tables = [...graph.nodes.values()].filter((n) => n.kind === 'table');
  assert.deepEqual(tables.map((n) => n.id.slice('table:'.length)).sort(), [
    'account', 'bannerdata', 'category', 'inventory', 'item', 'lineitem',
    'orders', 'orderstatus', 'product', 'profile', 'sequence', 'signon',
    'supplier',
  ]);
  assert.deepEqual(tables.filter((n) => n.stub), [], 'a stub table here means an identity that did not match');
  // 86 columns, all of them the catalog's — the 53 upper-case ones the SQL used
  // to invent are gone because they were never a second column.
  const columns = [...graph.nodes.values()].filter((n) => n.kind === 'column').map((n) => n.id);
  assert.equal(columns.length, 86);
  assert.equal(columns.filter((c) => /^column:[A-Z]/.test(c)).length, 0);

  // The reads are what the defect lost outright, and they are back. 231 column
  // facts split 160 read / 71 write; the write side grew from 53 to 71 because
  // eleven INSERT/UPDATE statements now write CATALOG columns rather than
  // columns of a stub. Hand-checked against the mappers:
  //   insertOrder writes the 25 columns of its INSERT list (OrderMapper.xml
  //   lines 93-96), and getItem reads 17: ITEM's 11 + PRODUCT's 4 + INVENTORY's
  //   2 (ItemMapper.xml lines 47-67).
  assert.equal(graph.edges.filter((e) => e.type === 'READS').length, 160);
  assert.equal(graph.edges.filter((e) => e.type === 'WRITES').length, 71);
  // One JOINS edge per distinct table pair the SQL witnesses (11 predicates, 6
  // pairs — the arithmetic is in SPOT CHECK 2 of the test above).
  assert.equal(graph.edges.filter((e) => e.type === 'JOINS').length, 6);

  const writes = graph.edges.filter((e) => e.type === 'WRITES'
    && e.from === 'statement:org.mybatis.jpetstore.mapper.OrderMapper.insertOrder');
  assert.equal(writes.length, 25);
  assert.ok(writes.every((e) => e.to.startsWith('column:orders.')), 'every write lands on the catalog table');
});

test('mybatis/jpetstore-6: the fold is the whole difference — exact reproduces the old defect', { timeout: 900000 }, (t) => {
  const why = preflight();
  if (why) { t.skip(why); return; }

  // The claim above ("case is the whole difference") is not left as prose. This
  // runs the lineage worker THREE TIMES over the SAME catalog and the SAME
  // statements, changing only --identifier-case, and checks that:
  //   exact       reproduces M11's pinned defect numbers exactly, and
  //   fold-lower  and fold-upper produce byte-identical output.
  // It uses the workers directly rather than `analyze`, because that is the
  // narrowest place the difference can be attributed to.

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-jpetstore-fold-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const A = path.join(ENGINE_ROOT, 'adapters', 'sql');
  const run = (script, args) => spawnSync(VENV_PY, [path.join(A, script), ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });

  const catalog = run('catalog_ddl.py', [path.join(FIXTURE, DDL_REL)]);
  assert.equal(catalog.status, 0, catalog.stderr);
  const statements = run('mybatis_extract.py', ['--root', FIXTURE, path.join(FIXTURE, MAPPERS_REL)]);
  assert.equal(statements.status, 0, statements.stderr);
  const catFile = path.join(work, 'catalog.jsonl');
  const stmtFile = path.join(work, 'statements.jsonl');
  fs.writeFileSync(catFile, catalog.stdout);
  fs.writeFileSync(stmtFile, statements.stdout);

  const lineage = (identifierCase) => {
    const r = run('lineage.py', ['--catalog', catFile, '--statements', stmtFile,
      '--dialect', 'mysql', '--identifier-case', identifierCase]);
    assert.equal(r.status, 0, r.stderr);
    const summary = JSON.parse(r.stderr.trim().split('\n').pop());
    return { summary, stdout: r.stdout };
  };

  const exact = lineage('exact');
  const lower = lineage('fold-lower');
  const upper = lineage('fold-upper');

  // M11's pinned defect numbers, reproduced on demand.
  assert.equal(exact.summary.columnFacts, 53);
  assert.equal(exact.summary.unresolvedColumns, 180);
  assert.equal(exact.summary.unresolvedRate, 0.7725);
  assert.equal(exact.summary.joinFacts, 0);
  assert.equal(exact.summary.unresolvedJoins, 11);

  for (const [name, r] of [['fold-lower', lower], ['fold-upper', upper]]) {
    assert.equal(r.summary.columnFacts, 231, name);
    assert.equal(r.summary.unresolvedColumns, 1, name);
    assert.equal(r.summary.unresolvedRate, 0.0043, name);
    assert.equal(r.summary.joinFacts, 11, name);
    assert.equal(r.summary.unresolvedJoins, 0, name);
    assert.equal(r.summary.identifierCollisions, 0, name);
  }
  // The fold DIRECTION is invisible in the facts: names come from the catalog.
  assert.equal(lower.stdout, upper.stdout, 'fold-lower and fold-upper must agree byte for byte');
});
