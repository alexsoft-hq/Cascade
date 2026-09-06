import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../src/core/canonical.mjs';
import { findJdk } from '../scripts/ci-java-smoke.mjs';

// I-9 — THE INCREMENTAL CORRECTNESS ORACLE (SPEC §2.1 item 5, §11.2, §16.1).
//
// "An incremental re-analysis equals a cold re-analysis of the same state." That
// sentence is only worth anything if something tries to break it, so this file
// builds a real (small) Spring + MyBatis + MySQL project in a git repo, mutates a
// RANDOM subset of its files each round with a seeded PRNG, and after every round
// runs BOTH paths and compares the packs. If a shard is ever reused when it should
// not have been, the two packs disagree and this test fails.
//
// It spawns the real CLI, so it needs a JDK and the project's venv Python. When
// either is missing it SKIPS WITH THE REASON — never silently (SPEC §16.3).

const ENGINE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const CLI = path.join(ENGINE_ROOT, 'bin', 'cascade.mjs');
const VENV_PY = path.join(ENGINE_ROOT, '.venv', 'bin', 'python');

function preflight() {
  if (!fs.existsSync(VENV_PY)) {
    return `no venv python at ${VENV_PY} — run: python3 -m venv .venv && .venv/bin/pip install -r adapters/sql/requirements.txt (see docs/setup/sql-lane.md)`;
  }
  if (!findJdk()) {
    return 'no JDK found: JAVA_HOME is unset and no javac on PATH — install a JDK 21 (see docs/setup/java-lane.md); CI runs this check on temurin 21';
  }
  return null;
}

// ---------------------------------------------------------------------------
// the synthetic project: endpoint -> service -> mapper -> XML -> DDL, with a
// CROSS-FILE <include refid> fragment so the global fragment index is exercised.
// ---------------------------------------------------------------------------

const DDL = `-- synthetic schema for the incremental oracle
CREATE TABLE \`shop_item\` (
  \`id\` bigint(20) NOT NULL AUTO_INCREMENT,
  \`name\` varchar(64) DEFAULT NULL COMMENT 'item name',
  \`price\` decimal(10,2) DEFAULT NULL COMMENT 'unit price',
  \`stock\` int(11) DEFAULT NULL COMMENT 'stock count',
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

CREATE TABLE \`shop_order\` (
  \`id\` bigint(20) NOT NULL AUTO_INCREMENT,
  \`item_id\` bigint(20) DEFAULT NULL COMMENT 'ordered item',
  \`qty\` int(11) DEFAULT NULL COMMENT 'quantity',
  \`status\` varchar(16) DEFAULT NULL COMMENT 'order status',
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
`;

// Real mapper files carry the MyBatis DOCTYPE; this fixture leaves it out because
// the repository's own hygiene gate (test/gates.test.mjs) allows no host outside
// its allowlist, and mybatis_extract.py ignores the DOCTYPE either way — it walks
// the element tree, never the declaration.
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n';

const FILES = {
  'schema.sql': DDL,

  'src/main/resources/mapper/Common.xml': `${XML_HEAD}<mapper namespace="Common">
  <sql id="itemColumns">id, name, price, stock</sql>
</mapper>
`,

  'src/main/resources/mapper/ItemMapper.xml': `${XML_HEAD}<mapper namespace="com.example.mapper.ItemMapper">
  <select id="selectById" resultType="java.util.Map">
    select <include refid="Common.itemColumns"/> from shop_item where id = #{id}
  </select>
  <update id="updatePrice">
    update shop_item set price = #{price} where id = #{id}
  </update>
  <insert id="insertItem">
    insert into shop_item (name, price, stock) values (#{name}, #{price}, #{stock})
  </insert>
</mapper>
`,

  'src/main/resources/mapper/OrderMapper.xml': `${XML_HEAD}<mapper namespace="com.example.mapper.OrderMapper">
  <select id="selectItemsOfOrder" resultType="java.util.Map">
    select <include refid="Common.itemColumns"/> from shop_item where id = #{itemId}
  </select>
  <update id="closeOrder">
    update shop_order set status = #{status} where id = #{id}
  </update>
</mapper>
`,

  'src/main/java/com/example/mapper/ItemMapper.java': `package com.example.mapper;

public interface ItemMapper {
    String selectById(Long id);
    String updatePrice(Long id, Long price);
    String insertItem(String name, Long price, Integer stock);
}
`,

  'src/main/java/com/example/mapper/OrderMapper.java': `package com.example.mapper;

public interface OrderMapper {
    String selectItemsOfOrder(Long itemId);
    String closeOrder(Long id, String status);
}
`,

  'src/main/java/com/example/service/ItemService.java': `package com.example.service;

import org.springframework.transaction.annotation.Transactional;

public interface ItemService {
    String find(Long id);

    @Transactional
    String changePrice(Long id, Long price);
}
`,

  'src/main/java/com/example/service/OrderService.java': `package com.example.service;

public interface OrderService {
    String itemsOf(Long itemId);
    String close(Long id, String status);
}
`,

  'src/main/java/com/example/service/impl/ItemServiceImpl.java': `package com.example.service.impl;

import com.example.mapper.ItemMapper;
import com.example.service.ItemService;

public class ItemServiceImpl implements ItemService {
    private ItemMapper itemMapper;

    public String find(Long id) {
        return itemMapper.selectById(id);
    }

    public String changePrice(Long id, Long price) {
        return itemMapper.updatePrice(id, price);
    }
}
`,

  'src/main/java/com/example/service/impl/OrderServiceImpl.java': `package com.example.service.impl;

import com.example.mapper.OrderMapper;
import com.example.service.OrderService;

public class OrderServiceImpl implements OrderService {
    private OrderMapper orderMapper;

    public String itemsOf(Long itemId) {
        return orderMapper.selectItemsOfOrder(itemId);
    }

    public String close(Long id, String status) {
        return orderMapper.closeOrder(id, status);
    }
}
`,

  'src/main/java/com/example/web/ItemController.java': `package com.example.web;

import com.example.service.ItemService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/item")
public class ItemController {
    private ItemService itemService;

    @GetMapping("/get")
    public String get(Long id) {
        return itemService.find(id);
    }

    @PostMapping("/price")
    public String price(Long id, Long price) {
        return itemService.changePrice(id, price);
    }
}
`,

  'src/main/java/com/example/web/OrderController.java': `package com.example.web;

import com.example.service.OrderService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/order")
public class OrderController {
    private OrderService orderService;

    @GetMapping("/items")
    public String items(Long itemId) {
        return orderService.itemsOf(itemId);
    }
}
`,

  // ---- the frontend (RM29) -------------------------------------------------
  // A small Vue package beside the backend, calling the routes the controllers
  // above serve. It is here so the oracle covers the WEB lane's shards too: the
  // per-file facts, the package configuration that is never cached, and the
  // `.env` value that reshapes every URL the client sends.
  'front/package.json': `{
  "name": "oracle-front",
  "private": true,
  "dependencies": { "vue": "3.4.0", "axios": "1.6.0" }
}
`,

  'front/jsconfig.json': `{
  "compilerOptions": { "paths": { "@/*": ["src/*"] } }
}
`,

  'front/.env.development': `VUE_APP_API_BASE=/api
`,

  'front/vue.config.js': `module.exports = {
  devServer: {
    proxy: {
      '/api': { target: 'http://localhost:8080', pathRewrite: { '^/api': '' } },
    },
  },
};
`,

  'front/src/utils/http.js': `import axios from 'axios';

const client = axios.create({ baseURL: process.env.VUE_APP_API_BASE });

export default client;
`,

  'front/src/api/items.js': `import client from '@/utils/http';

export function getItem(id) {
  return client.get('/item/get', { params: { id } });
}

export function setPrice(id, price) {
  return client.post('/item/price', { id, price });
}
`,

  'front/src/api/orders.js': `import client from '@/utils/http';

export function orderItems(itemId) {
  return client.get('/order/items', { params: { itemId } });
}
`,

  'front/src/views/Items.vue': `<template>
  <div class="items">{{ name }}</div>
</template>

<script>
import { getItem } from '@/api/items';

export default {
  name: 'ItemsView',
  data() {
    return { name: '' };
  },
  methods: {
    async load(id) {
      const r = await getItem(id);
      this.name = r.data.name;
    },
  },
};
</script>
`,
};

const JAVA_ROOT = 'src/main/java';
const MAPPER_DIR = 'src/main/resources/mapper';
const WEB_ROOT = 'front/src';

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_NAME: 'oracle', GIT_AUTHOR_EMAIL: 'oracle@example.com', GIT_COMMITTER_NAME: 'oracle', GIT_COMMITTER_EMAIL: 'oracle@example.com' },
  }).toString('utf8');
}

function makeRepo(dir) {
  for (const [rel, body] of Object.entries(FILES)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body, 'utf8');
  }
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'synthetic project']);
  return dir;
}

/** Run `cascade analyze` over the repo. Returns {pack, stderr, ms}. */
function analyze(repo, outDir, cacheHome, extra = []) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [
    CLI, 'analyze',
    '--root', repo,
    '--out', outDir,
    '--project', 'oracle',
    '--ddl', path.join(repo, 'schema.sql'),
    '--mappers', path.join(repo, MAPPER_DIR),
    '--java-src', path.join(repo, JAVA_ROOT),
    '--web-src', path.join(repo, WEB_ROOT),
    ...extra,
  ], {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    env: { ...process.env, XDG_CACHE_HOME: path.join(cacheHome, 'cache'), CASCADE_HOME: path.join(cacheHome, 'home') },
  });
  const ms = Date.now() - started;
  if (r.status !== 0) throw new Error(`cascade analyze exited ${r.status}\n--- stderr ---\n${r.stderr}`);
  const pack = JSON.parse(fs.readFileSync(path.join(outDir, 'pack.json'), 'utf8'));
  return { pack, stderr: r.stderr, ms };
}

/** The pack's CONTENT, with every scrap of metadata removed. */
const content = (pack) => canonicalJson({ nodes: pack.nodes, edges: pack.edges });

/** Deterministic PRNG (mulberry32) — the mutation sequence is reproducible. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const read = (repo, rel) => fs.readFileSync(path.join(repo, rel), 'utf8');
const write = (repo, rel, s) => fs.writeFileSync(path.join(repo, rel), s, 'utf8');

// ---------------------------------------------------------------------------
// the mutation menu. Each returns null when it cannot apply this round.
// ---------------------------------------------------------------------------

function mutations(repo, state) {
  const extras = () => fs.readdirSync(path.join(repo, JAVA_ROOT, 'com/example/web'))
    .filter((f) => f.startsWith('Extra')).sort();
  return {
    // 1. a service gains a call to another mapper method
    addCall() {
      const rel = `${JAVA_ROOT}/com/example/service/impl/ItemServiceImpl.java`;
      const n = state.n++;
      const body = read(repo, rel);
      const method = `\n    public String extra${n}(String name, Long price, Integer stock) {\n`
        + `        return itemMapper.insertItem(name, price, stock);\n    }\n`;
      write(repo, rel, body.replace(/\n\}\n$/, `\n${method}}\n`));
      return { name: `addCall#${n}`, java: 1, xml: 0, ddl: 0 };
    },
    // 2. a column is renamed in the DDL (the catalog moves under every statement)
    renameDdlColumn() {
      const n = state.n++;
      const before = state.stockColumn;
      state.stockColumn = `stock_v${n}`;
      write(repo, 'schema.sql', read(repo, 'schema.sql').split(`\`${before}\``).join(`\`${state.stockColumn}\``));
      return { name: `renameDdlColumn#${n}`, java: 0, xml: 0, ddl: 1 };
    },
    // 3. the SHARED fragment's column list changes (two mapper files feel it)
    changeFragment() {
      const n = state.n++;
      state.fragmentWide = !state.fragmentWide;
      const cols = state.fragmentWide ? 'id, name, price, stock' : 'id, name, price';
      write(repo, `${MAPPER_DIR}/Common.xml`,
        read(repo, `${MAPPER_DIR}/Common.xml`).replace(/<sql id="itemColumns">[^<]*<\/sql>/, `<sql id="itemColumns">${cols}</sql>`));
      return { name: `changeFragment#${n}(${cols})`, java: 0, xml: 1, ddl: 0 };
    },
    // 4. a java file is deleted
    deleteJava() {
      const list = extras();
      if (list.length === 0) return null;
      const victim = list[0];
      fs.rmSync(path.join(repo, JAVA_ROOT, 'com/example/web', victim));
      return { name: `deleteJava(${victim})`, java: 1, xml: 0, ddl: 0, deleted: victim };
    },
    // 5. a whole new controller appears
    addController() {
      const n = state.n++;
      const cls = `Extra${n}Controller`;
      write(repo, `${JAVA_ROOT}/com/example/web/${cls}.java`, `package com.example.web;

import com.example.service.ItemService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/extra${n}")
public class ${cls} {
    private ItemService itemService;

    @GetMapping("/get")
    public String get(Long id) {
        return itemService.find(id);
    }
}
`);
      return { name: `addController(${cls})`, java: 1, xml: 0, ddl: 0 };
    },
    // 7. a frontend call points at a different route
    editUrl() {
      const n = state.n++;
      const rel = 'front/src/api/items.js';
      const before = state.itemUrl;
      state.itemUrl = `/item/get${n}`;
      write(repo, rel, read(repo, rel).split(`'${before}'`).join(`'${state.itemUrl}'`));
      return { name: `editUrl#${n}(${state.itemUrl})`, java: 0, xml: 0, ddl: 0, web: 1 };
    },
    // 8. a new api module appears
    addApiFile() {
      const n = state.n++;
      write(repo, `${WEB_ROOT}/api/extra${n}.js`, `import client from '@/utils/http';

export function extra${n}(id) {
  return client.get('/item/get', { params: { id } });
}
`);
      return { name: `addApiFile(extra${n}.js)`, java: 0, xml: 0, ddl: 0, web: 1 };
    },
    // 9. ...and one of them is deleted again
    deleteApiFile() {
      const list = fs.readdirSync(path.join(repo, WEB_ROOT, 'api'))
        .filter((f) => f.startsWith('extra')).sort();
      if (list.length === 0) return null;
      fs.rmSync(path.join(repo, WEB_ROOT, 'api', list[0]));
      return { name: `deleteApiFile(${list[0]})`, java: 0, xml: 0, ddl: 0, web: 1, deleted: list[0] };
    },
    // 10. the package's own configuration moves: the base every URL is built on
    editEnv() {
      const n = state.n++;
      const before = state.apiBase;
      state.apiBase = state.apiBase === '/api' ? '/api-v2' : '/api';
      write(repo, 'front/.env.development', read(repo, 'front/.env.development').replace(before, state.apiBase));
      return { name: `editEnv#${n}(${state.apiBase})`, java: 0, xml: 0, ddl: 0, web: 0, config: 1 };
    },
    // 11. a template-only edit to a single-file component: the bytes move, the
    //     script block does not, so the shard is recomputed and the pack is not.
    touchVue() {
      const n = state.n++;
      const rel = `${WEB_ROOT}/views/Items.vue`;
      write(repo, rel, read(repo, rel).replace(/class="items[^"]*"/, `class="items v${n}"`));
      return { name: `touchVue#${n}`, java: 0, xml: 0, ddl: 0, web: 1 };
    },
    // 6. a semantic no-op: a trailing comment, appended AFTER the last brace so
    //    no declaration's line number moves (line numbers ARE part of the pack).
    touchNoop() {
      const n = state.n++;
      const rel = `${JAVA_ROOT}/com/example/web/OrderController.java`;
      write(repo, rel, `${read(repo, rel)}// noop ${n}\n`);
      return { name: `touchNoop#${n}`, java: 1, xml: 0, ddl: 0 };
    },
  };
}

// ---------------------------------------------------------------------------

test('I-9 metamorphic oracle: incremental == cold after random mutations', { timeout: 600000 }, (t) => {
  const why = preflight();
  if (why) { t.skip(why); return; }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-oracle-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const repo = makeRepo(path.join(work, 'repo'));
  const incOut = path.join(work, 'inc');
  const coldOut = path.join(work, 'cold');
  const cache = path.join(work, 'xdg');

  // --- determinism first: the same tree twice gives the same digest ---------
  const d0 = analyze(repo, coldOut, cache, ['--cold']);
  const d0b = analyze(repo, coldOut, cache, ['--cold']);
  assert.equal(d0b.pack.digest, d0.pack.digest, 'a cold run is not deterministic — nothing below means anything');
  assert.equal(content(d0b.pack), content(d0.pack));
  assert.ok(d0.pack.counts.nodes > 20, `the synthetic project is too small to test anything (${d0.pack.counts.nodes} nodes)`);
  // and the project really has the chain the oracle is about
  assert.ok(d0.pack.nodes.some((n) => n.id === 'endpoint:GET /item/get'), 'no endpoint in the synthetic pack');
  assert.ok(d0.pack.nodes.some((n) => n.id === 'column:shop_item.price'), 'no column in the synthetic pack');
  assert.ok(d0.pack.edges.some((e) => e.type === 'IMPLEMENTS_STMT'), 'the mapper methods did not bind to statements');

  // the first incremental run has no index, so it is cold AND SAYS SO
  const first = analyze(repo, incOut, cache);
  assert.equal(first.pack.meta.incremental.mode, 'cold');
  assert.match(first.stderr, /cold \(no previous facts-index\.json/);
  assert.equal(first.pack.digest, d0.pack.digest, 'the two output directories must describe the same tree');

  const state = { n: 1, stockColumn: 'stock', fragmentWide: true, itemUrl: '/item/get', apiBase: '/api' };
  const menu = mutations(repo, state);
  const names = Object.keys(menu);
  const rand = prng(20260904);
  const log = [];

  for (let round = 1; round <= 7; round += 1) {
    // a random SUBSET of the menu, applied together
    const howMany = 1 + Math.floor(rand() * 3);
    const applied = [];
    const chosen = new Set();
    for (let k = 0; k < howMany; k += 1) chosen.add(names[Math.floor(rand() * names.length)]);
    for (const name of chosen) {
      const m = menu[name]();
      if (m) applied.push(m);
    }
    if (applied.length === 0) { menu.touchNoop(); applied.push({ name: 'touchNoop(fallback)', java: 1, xml: 0, ddl: 0 }); }
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', `round ${round}: ${applied.map((m) => m.name).join(', ')}`]);

    const incr = analyze(repo, incOut, cache);
    const cold = analyze(repo, coldOut, cache, ['--cold']);
    const meta = incr.pack.meta.incremental;

    assert.equal(meta.mode, 'incremental',
      `round ${round} fell back to cold (${meta.reason}) — the oracle would be comparing cold with cold`);
    assert.equal(incr.pack.digest, cold.pack.digest,
      `round ${round} [${applied.map((m) => m.name).join(', ')}]: incremental digest ${incr.pack.digest} != cold ${cold.pack.digest}`);
    assert.equal(content(incr.pack), content(cold.pack),
      `round ${round}: same digest but different canonical content — impossible unless the digest stopped covering the graph`);
    assert.equal(incr.pack.counts.nodes, cold.pack.counts.nodes);
    assert.equal(incr.pack.counts.edges, cold.pack.counts.edges);

    const touchedJava = applied.reduce((n, m) => n + m.java, 0);
    const touchedXml = applied.reduce((n, m) => n + m.xml, 0);
    const touchedDdl = applied.reduce((n, m) => n + m.ddl, 0);
    const touchedWeb = applied.reduce((n, m) => n + (m.web ?? 0), 0);

    if (touchedDdl === 0 && touchedXml === 0) {
      assert.ok(meta.reusedJava > 0,
        `round ${round} changed ${touchedJava} java file(s) and reused NOTHING — the java lane is not incremental`);
      assert.ok(meta.reparsedJava <= touchedJava,
        `round ${round} reparsed ${meta.reparsedJava} java files for ${touchedJava} edited one(s)`);
      assert.equal(meta.catalogReused, true, 'the DDL did not move, so the catalog must be reused');
      assert.equal(meta.statementsReused, true, 'no mapper moved, so the statement set must be reused');
      assert.ok(meta.reusedLineage > 0, 'no SQL input moved, so lineage must be reused');
    }
    // The web lane keeps the same discipline: only the frontend files that moved
    // are re-read, and the rest come out of their shards.
    assert.ok(meta.reusedWeb > 0,
      `round ${round} changed ${touchedWeb} frontend file(s) and reused NOTHING from the web lane`);
    assert.ok(meta.reparsedWeb <= touchedWeb,
      `round ${round} reparsed ${meta.reparsedWeb} frontend files for ${touchedWeb} edited one(s)`);
    if (touchedDdl > 0) {
      assert.equal(meta.reusedLineage, 0,
        `round ${round} changed the DDL but reused ${meta.reusedLineage} lineage shard(s) — the catalog digest is not reaching the key`);
      assert.equal(meta.catalogReused, false);
    }
    if (touchedXml > 0 && touchedDdl === 0) {
      assert.equal(meta.statementsReused, false, 'a mapper edit must rerun the extractor over ALL mappers');
    }
    log.push(`round ${round} [${applied.map((m) => m.name).join(', ')}] -> digest ${incr.pack.digest} `
      + `(java reparsed ${meta.reparsedJava}, reused ${meta.reusedJava}; `
      + `web reparsed ${meta.reparsedWeb}, reused ${meta.reusedWeb}, dropped ${meta.droppedWeb}; `
      + `lineage ${meta.recomputedLineage}/${meta.reusedLineage}) `
      + `inc ${incr.ms}ms vs cold ${cold.ms}ms`);
  }
  t.diagnostic(log.join('\n'));
});

test('a semantic no-op reparses the file and lands on the same digest', { timeout: 300000 }, (t) => {
  const why = preflight();
  if (why) { t.skip(why); return; }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-oracle-noop-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const repo = makeRepo(path.join(work, 'repo'));
  const out = path.join(work, 'inc');
  const cache = path.join(work, 'xdg');

  const before = analyze(repo, out, cache);
  // Trailing whitespace on a blank line + a comment past the last brace: the
  // bytes change, so the shard key changes and the file MUST be reparsed; not a
  // single declaration moves, so the pack must not.
  const rel = `${JAVA_ROOT}/com/example/service/impl/ItemServiceImpl.java`;
  write(repo, rel, `${read(repo, rel)}\n// whitespace-only round trip   \n`);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'no-op touch']);

  const after = analyze(repo, out, cache);
  assert.equal(after.pack.meta.incremental.mode, 'incremental');
  assert.equal(after.pack.meta.incremental.reparsedJava, 1, 'the touched file must be reparsed — its bytes changed');
  assert.ok(after.pack.meta.incremental.reusedJava >= 7, `only ${after.pack.meta.incremental.reusedJava} files reused`);
  assert.equal(after.pack.digest, before.pack.digest, 'a semantic no-op changed the pack');
  assert.equal(content(after.pack), content(before.pack));
});

test('a deleted java file leaves the incremental pack exactly as a cold run does', { timeout: 300000 }, (t) => {
  const why = preflight();
  if (why) { t.skip(why); return; }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-oracle-del-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const repo = makeRepo(path.join(work, 'repo'));
  const incOut = path.join(work, 'inc');
  const coldOut = path.join(work, 'cold');
  const cache = path.join(work, 'xdg');

  const before = analyze(repo, incOut, cache);
  assert.ok(before.pack.nodes.some((n) => n.id === 'endpoint:GET /order/items'));
  assert.ok(before.pack.nodes.some((n) => n.id === 'symbol:com.example.web.OrderController#items'));

  fs.rmSync(path.join(repo, JAVA_ROOT, 'com/example/web/OrderController.java'));
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'delete OrderController']);

  const incr = analyze(repo, incOut, cache);
  const cold = analyze(repo, coldOut, cache, ['--cold']);
  assert.equal(incr.pack.meta.incremental.mode, 'incremental');
  assert.equal(incr.pack.meta.incremental.droppedJava, 1);
  assert.equal(incr.pack.meta.incremental.reparsedJava, 0, 'a deletion is not a reparse');
  assert.equal(incr.pack.digest, cold.pack.digest);
  assert.equal(content(incr.pack), content(cold.pack));
  assert.equal(incr.pack.nodes.some((n) => n.id === 'symbol:com.example.web.OrderController#items'), false);
  // The ROUTE does not simply vanish: the frontend still calls `/order/items`,
  // so what is left is an endpoint nothing in this pack serves — an OUTBOUND
  // target, with no handler. That is the honest reading of the deletion, and it
  // is what a cold run says too.
  const orphan = incr.pack.nodes.find((n) => n.id === 'endpoint:GET /order/items');
  assert.ok(orphan, 'the frontend still names the route, so the node is still there');
  assert.equal(orphan.outbound, true, 'nothing in this pack handles it any more');
  assert.equal(incr.pack.edges.some((e) => e.to === 'endpoint:GET /order/items' && e.type === 'HANDLES'), false);
});

test('a frontend edit re-reads that file only, and a template-only touch lands on the same digest', { timeout: 300000 }, (t) => {
  const why = preflight();
  if (why) { t.skip(why); return; }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-oracle-web-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const repo = makeRepo(path.join(work, 'repo'));
  const incOut = path.join(work, 'inc');
  const coldOut = path.join(work, 'cold');
  const cache = path.join(work, 'xdg');

  const before = analyze(repo, incOut, cache);
  // The fixture is the shape this test is about: the frontend calls the routes
  // the controllers serve, and the calls are edges.
  assert.ok(before.pack.edges.some((e) => e.type === 'CALLS_HTTP' && e.from === 'symbol:front/src/api/items.js#getItem'
    && e.to === 'endpoint:GET /item/get'), 'the frontend call did not reach the route');

  // (1) a template-only edit: the bytes move, so the shard is recomputed; not a
  //     declaration moves, so the pack must not.
  const vue = `${WEB_ROOT}/views/Items.vue`;
  write(repo, vue, read(repo, vue).replace('class="items"', 'class="items is-wide"'));
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'template only']);

  const touched = analyze(repo, incOut, cache);
  assert.equal(touched.pack.meta.incremental.mode, 'incremental');
  assert.equal(touched.pack.meta.incremental.reparsedWeb, 1, 'the touched .vue must be re-read: its bytes changed');
  assert.equal(touched.pack.meta.incremental.reusedWeb, 3);
  assert.equal(touched.pack.meta.incremental.reparsedJava, 0, 'a frontend edit costs the Java lane nothing');
  assert.equal(touched.pack.digest, before.pack.digest, 'a template-only edit changed the pack');

  // (2) a real edit: one URL literal moves, one file is re-read, and the pack
  //     follows the code.
  const api = `${WEB_ROOT}/api/items.js`;
  write(repo, api, read(repo, api).replace("'/item/get'", "'/item/fetch'"));
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'move the URL']);

  const moved = analyze(repo, incOut, cache);
  const cold = analyze(repo, coldOut, cache, ['--cold']);
  assert.equal(moved.pack.meta.incremental.reparsedWeb, 1);
  assert.notEqual(moved.pack.digest, before.pack.digest, 'the URL moved and the pack did not');
  assert.equal(moved.pack.digest, cold.pack.digest, 'incremental and cold disagree about the edited frontend');
  assert.equal(moved.pack.edges.some((e) => e.type === 'CALLS_HTTP' && e.to === 'endpoint:GET /item/get'), false);
  assert.ok(moved.pack.nodes.some((n) => n.id === 'endpoint:GET /item/fetch' && n.outbound === true),
    'the call now names a route nothing here serves, and the pack says so');
});

test('a deleted frontend file leaves the incremental pack exactly as a cold run does', { timeout: 300000 }, (t) => {
  const why = preflight();
  if (why) { t.skip(why); return; }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-oracle-webdel-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const repo = makeRepo(path.join(work, 'repo'));
  const incOut = path.join(work, 'inc');
  const coldOut = path.join(work, 'cold');
  const cache = path.join(work, 'xdg');

  const before = analyze(repo, incOut, cache);
  assert.ok(before.pack.nodes.some((n) => n.id === 'symbol:front/src/api/orders.js#orderItems'));

  fs.rmSync(path.join(repo, WEB_ROOT, 'api', 'orders.js'));
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'delete the orders api module']);

  const incr = analyze(repo, incOut, cache);
  const cold = analyze(repo, coldOut, cache, ['--cold']);
  assert.equal(incr.pack.meta.incremental.mode, 'incremental');
  assert.equal(incr.pack.meta.incremental.droppedWeb, 1);
  assert.equal(incr.pack.meta.incremental.reparsedWeb, 0, 'a deletion is not a re-read');
  assert.equal(incr.pack.digest, cold.pack.digest);
  assert.equal(content(incr.pack), content(cold.pack));
  assert.equal(incr.pack.nodes.some((n) => n.id === 'symbol:front/src/api/orders.js#orderItems'), false,
    'the deleted module still has a symbol in the incremental pack');
});

test('a corrupt shard is detected and recomputed, never loaded (tamper)', { timeout: 300000 }, (t) => {
  const why = preflight();
  if (why) { t.skip(why); return; }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-oracle-tamper-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const repo = makeRepo(path.join(work, 'repo'));
  const out = path.join(work, 'inc');
  const cache = path.join(work, 'xdg');

  const good = analyze(repo, out, cache);
  const index = JSON.parse(fs.readFileSync(path.join(out, 'facts-index.json'), 'utf8'));
  const casRoot = path.join(cache, 'cache', 'cascade', 'oracle', 'cas');

  // Truncate one java shard and blank one lineage shard.
  const victimFile = `${JAVA_ROOT}/com/example/service/impl/ItemServiceImpl.java`;
  const javaShard = path.join(casRoot, `javafacts-${index.files[victimFile].shardKey}`, 'facts.jsonl');
  assert.ok(fs.existsSync(javaShard), `expected a shard at ${javaShard}`);
  fs.writeFileSync(javaShard, fs.readFileSync(javaShard, 'utf8').slice(0, 40), 'utf8');
  const stmtKey = index.statements['com.example.mapper.ItemMapper.updatePrice'].shardKey;
  const lineageShard = path.join(casRoot, `lineage-${stmtKey}`, 'facts.jsonl');
  fs.writeFileSync(lineageShard, '', 'utf8');

  const after = analyze(repo, out, cache);
  assert.equal(after.pack.meta.incremental.mode, 'incremental');
  assert.equal(after.pack.meta.incremental.shardsRecovered, 2, 'both damaged shards must be noticed');
  assert.match(after.stderr, /SHARD_UNUSABLE/);
  assert.match(after.stderr, /recomputed from source instead of reused/);
  assert.equal(after.pack.digest, good.pack.digest, 'the recovered pack must equal the healthy one');
  assert.equal(content(after.pack), content(good.pack));
});

test('the incremental path declines and says why when the changeset is UNKNOWN', { timeout: 300000 }, (t) => {
  const why = preflight();
  if (why) { t.skip(why); return; }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-oracle-unknown-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const repo = makeRepo(path.join(work, 'repo'));
  const out = path.join(work, 'inc');
  const cache = path.join(work, 'xdg');

  analyze(repo, out, cache);
  // Rewrite history so the recorded base commit no longer exists: git can no
  // longer answer "what changed", and UNKNOWN must become COLD, out loud.
  const idx = JSON.parse(fs.readFileSync(path.join(out, 'facts-index.json'), 'utf8'));
  idx.base = { ...idx.base, commit: '0'.repeat(40) };
  fs.writeFileSync(path.join(out, 'facts-index.json'), JSON.stringify(idx));

  const r = analyze(repo, out, cache, ['--incremental']);
  assert.equal(r.pack.meta.incremental.mode, 'cold');
  assert.match(r.stderr, /--incremental was asked for, but this run must be cold/);
  assert.match(r.stderr, /changeset is UNKNOWN/);
  assert.match(r.stderr, /is not in this repository any more/);
});

test('a dirty analysis input is recorded on the pack and re-read next run', { timeout: 300000 }, (t) => {
  const why = preflight();
  if (why) { t.skip(why); return; }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-oracle-dirty-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const repo = makeRepo(path.join(work, 'repo'));
  const incOut = path.join(work, 'inc');
  const coldOut = path.join(work, 'cold');
  const cache = path.join(work, 'xdg');

  analyze(repo, incOut, cache);
  // Edit WITHOUT committing: the analysis reads the working tree, so the pack
  // must say it is not a description of HEAD.
  const rel = `${JAVA_ROOT}/com/example/web/ItemController.java`;
  write(repo, rel, read(repo, rel).replace('@PostMapping("/price")', '@PostMapping("/price-v2")'));
  const dirty = analyze(repo, incOut, cache);
  assert.equal(dirty.pack.meta.base.dirty, true);
  assert.deepEqual(dirty.pack.meta.base.dirtyFiles, [rel]);
  assert.match(dirty.stderr, /DIRTY analysis input/);
  assert.ok(dirty.pack.nodes.some((n) => n.id === 'endpoint:POST /item/price-v2'), 'the working-tree edit was not analyzed');

  // Now revert it. git diff <base> reports NOTHING (the file matches the commit
  // again), so only the recorded dirty list can save us from a stale shard.
  write(repo, rel, FILES[rel]);
  const reverted = analyze(repo, incOut, cache);
  const cold = analyze(repo, coldOut, cache, ['--cold']);
  assert.equal(reverted.pack.meta.incremental.mode, 'incremental');
  assert.equal(reverted.pack.meta.base.dirty, false);
  assert.equal(reverted.pack.digest, cold.pack.digest,
    'a reverted dirty file kept its stale shard — the previous run\'s dirty list is not being honoured');
  assert.equal(reverted.pack.nodes.some((n) => n.id === 'endpoint:POST /item/price-v2'), false);
});
