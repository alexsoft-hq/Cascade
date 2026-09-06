import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadPack } from '../src/core/pack.mjs';
import { changeImpact } from '../src/core/overlay.mjs';
import { findJdk } from '../scripts/ci-java-smoke.mjs';

// OVERLAY ⊆ FULL, and DISCARD ON COMMIT (SPEC §10.2 MUST, §16.1 metamorphic).
//
// The overlay is allowed to be an over-approximation and forbidden to omit: a
// certified re-analysis of the SAME worktree state may not report an endpoint
// or a column the overlay left out. So each scenario is run twice — once
// through the real CLI's overlay (spawned, so the workers, the shard cache and
// the git plumbing are all real), once through a full `cascade analyze` of the
// same bytes into a separate directory — and the two answers are compared.
//
// Needs a JDK and the project's venv Python; when either is missing the test
// SKIPS WITH THE REASON, never silently (SPEC §16.3).

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
// A small Spring + MyBatis + MySQL project. ItemMapper has TWO statements, and
// the base code path only ever calls one of them — so "a service edit reaches a
// new table" is one added call, and the base answer provably lacks it.
// ---------------------------------------------------------------------------

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n';
const JAVA_ROOT = 'src/main/java';
const MAPPER_DIR = 'src/main/resources/mapper';
const WEB_ROOT = 'front/src';
const IMPL = `${JAVA_ROOT}/com/example/service/impl/ItemServiceImpl.java`;
const NEW_CONTROLLER = `${JAVA_ROOT}/com/example/web/ExtraController.java`;
const CONTROLLER = `${JAVA_ROOT}/com/example/web/ItemController.java`;
const VIEW = `${WEB_ROOT}/views/Items.vue`;

const FILES = {
  'schema.sql': `CREATE TABLE \`shop_item\` (
  \`id\` bigint(20) NOT NULL AUTO_INCREMENT,
  \`name\` varchar(64) DEFAULT NULL COMMENT 'item name',
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

CREATE TABLE \`shop_stock\` (
  \`item_id\` bigint(20) NOT NULL,
  \`qty\` int(11) DEFAULT NULL COMMENT 'stock count',
  PRIMARY KEY (\`item_id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
`,

  [`${MAPPER_DIR}/ItemMapper.xml`]: `${XML_HEAD}<mapper namespace="com.example.mapper.ItemMapper">
  <select id="selectById" resultType="java.util.Map">
    select id, name from shop_item where id = #{id}
  </select>
  <update id="updateStock">
    update shop_stock set qty = #{qty} where item_id = #{id}
  </update>
</mapper>
`,

  [`${JAVA_ROOT}/com/example/mapper/ItemMapper.java`]: `package com.example.mapper;

public interface ItemMapper {
    String selectById(Long id);
    int updateStock(Long id, Integer qty);
}
`,

  [`${JAVA_ROOT}/com/example/service/ItemService.java`]: `package com.example.service;

public interface ItemService {
    String find(Long id);
}
`,

  [IMPL]: `package com.example.service.impl;

import com.example.mapper.ItemMapper;
import com.example.service.ItemService;

public class ItemServiceImpl implements ItemService {
    private ItemMapper itemMapper;

    public String find(Long id) {
        return itemMapper.selectById(id);
    }
}
`,

  [CONTROLLER]: `package com.example.web;

import com.example.service.ItemService;
import org.springframework.web.bind.annotation.GetMapping;
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
}
`,

  // ---- the frontend (RM29) -------------------------------------------------
  // A Vue package beside the backend. Its api module calls the route the
  // controller above serves; the VIEW starts with no HTTP call at all, so the
  // scenario below ("edit a .vue so it calls the API") is a real edit and not a
  // restatement of what the base pack already knew.
  'front/package.json': `{
  "name": "overlay-front",
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

  [`${WEB_ROOT}/utils/http.js`]: `import axios from 'axios';

const client = axios.create({ baseURL: process.env.VUE_APP_API_BASE });

export default client;
`,

  [`${WEB_ROOT}/api/items.js`]: `import client from '@/utils/http';

export function getItem(id) {
  return client.get('/item/get', { params: { id } });
}
`,

  [VIEW]: `<template>
  <div class="items">{{ name }}</div>
</template>

<script>
export default {
  name: 'ItemsView',
  data() {
    return { name: '' };
  },
};
</script>
`,
};

/** The frontend edit under test: the view now calls the API itself. */
const VIEW_EDITED = `<template>
  <div class="items">{{ name }}</div>
</template>

<script>
import client from '@/utils/http';

export default {
  name: 'ItemsView',
  data() {
    return { name: '' };
  },
  methods: {
    async load(id) {
      const r = await client.get('/item/get', { params: { id } });
      this.name = r.data.name;
    },
  },
};
</script>
`;

/** The edit under test: the service now also calls the mapper method that writes shop_stock. */
const IMPL_EDITED = `package com.example.service.impl;

import com.example.mapper.ItemMapper;
import com.example.service.ItemService;

public class ItemServiceImpl implements ItemService {
    private ItemMapper itemMapper;

    public String find(Long id) {
        itemMapper.updateStock(id, 1);
        return itemMapper.selectById(id);
    }
}
`;

const EXTRA_CONTROLLER = `package com.example.web;

import com.example.service.ItemService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/extra")
public class ExtraController {
    private ItemService itemService;

    @GetMapping("/get")
    public String get(Long id) {
        return itemService.find(id);
    }
}
`;

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'overlay', GIT_AUTHOR_EMAIL: 'overlay@example.com',
  GIT_COMMITTER_NAME: 'overlay', GIT_COMMITTER_EMAIL: 'overlay@example.com',
};
function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...GIT_ENV } }).toString('utf8');
}

function makeRepo(dir) {
  for (const [rel, body] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body, 'utf8');
  }
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'base']);
  return dir;
}

function cli(args, cacheHome) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8', maxBuffer: 1 << 28,
    env: { ...process.env, XDG_CACHE_HOME: path.join(cacheHome, 'cache'), CASCADE_HOME: path.join(cacheHome, 'home') },
  });
}

function analyze(repo, outDir, cacheHome, extra = []) {
  const r = cli(['analyze', '--root', repo, '--out', outDir, '--project', 'ovl',
    '--ddl', path.join(repo, 'schema.sql'),
    '--mappers', path.join(repo, MAPPER_DIR),
    '--java-src', path.join(repo, JAVA_ROOT),
    '--web-src', path.join(repo, WEB_ROOT), ...extra], cacheHome);
  if (r.status !== 0) throw new Error(`cascade analyze exited ${r.status}\n${r.stderr}`);
  return { pack: JSON.parse(fs.readFileSync(path.join(outDir, 'pack.json'), 'utf8')), stderr: r.stderr };
}

/** Ask the REAL MCP server for changed_impact and return the contract response. */
function mcpChangedImpact(repo, packDir, cacheHome, args = {}) {
  const lines = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'changed_impact', arguments: args } }),
  ].join('\n') + '\n';
  const r = spawnSync(process.execPath, [CLI, 'mcp', '--pack', packDir], {
    input: lines, encoding: 'utf8', maxBuffer: 1 << 28,
    env: { ...process.env, XDG_CACHE_HOME: path.join(cacheHome, 'cache'), CASCADE_HOME: path.join(cacheHome, 'home') },
  });
  if (r.status !== 0) throw new Error(`cascade mcp exited ${r.status}\n${r.stderr}`);
  const out = r.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const call = out.find((m) => m.id === 2);
  assert.ok(call, `no tools/call response:\n${r.stdout}\n${r.stderr}`);
  if (call.result.isError) return { isError: true, text: call.result.content[0].text };
  return JSON.parse(call.result.content[0].text);
}

/**
 * What a CERTIFIED re-analysis of the same worktree says about these files.
 * Computed in-process from the freshly built pack with the very function the
 * server runs, so the comparison is answer-to-answer, not pipeline-to-pipeline.
 */
function fullAnswer(pack, files) {
  const g = loadPack(pack, { verifyDigest: true });
  const r = changeImpact(g, files, { mode: 'conservative' });
  return {
    endpoints: r.upstreamEndpoints.map((e) => e.id).sort(),
    columns: r.downstreamColumns.map((c) => c.id).sort(),
  };
}

/**
 * The contract as it survives the wire. `assertContract` cannot be used here:
 * its forgery marker is a Symbol and JSON.parse legitimately drops it (that is
 * invariant I-8 working). What a CLIENT can check is checked instead.
 */
function assertContractShape(resp) {
  for (const f of ['answer', 'basis', 'trust', 'limits', 'truncated']) {
    assert.ok(f in resp, `the response is missing the contract field ${f}`);
  }
  assert.ok(['current', 'behind', 'provisional-overlay', 'unknown'].includes(resp.basis.freshness.verdict),
    `unknown freshness verdict ${resp.basis.freshness.verdict}`);
  assert.ok(resp.basis.buildDigest, 'the basis must anchor to a pack digest');
  assert.ok(Array.isArray(resp.trust.axes) && resp.trust.axes.length > 0);
  for (const d of resp.truncated.fields) {
    assert.equal(d.shown, resp.answer[d.field].length, `truncated.shown disagrees with ${d.field}`);
    assert.ok(d.shown <= d.total);
  }
  // A provisional row may only appear under the provisional-overlay verdict.
  const rows = [...resp.answer.upstreamEndpoints, ...resp.answer.downstreamColumns];
  if (rows.some((r) => r.provisional)) {
    assert.equal(resp.basis.freshness.verdict, 'provisional-overlay',
      'a provisional row was reported under a verdict that does not disclose the overlay');
  }
}

function overlayAnswer(resp) {
  return {
    endpoints: resp.answer.upstreamEndpoints.map((e) => `endpoint:${e.id}`).sort(),
    columns: resp.answer.downstreamColumns.map((c) => `column:${c.id}`).sort(),
  };
}

function assertFullSubsetOfOverlay(full, overlay, what) {
  for (const kind of ['endpoints', 'columns']) {
    const missing = full[kind].filter((x) => !overlay[kind].includes(x));
    assert.deepEqual(missing, [],
      `${what}: the full re-analysis reports ${kind} the overlay omitted — over-approximation is allowed, omission is not.\n`
      + `  full:    ${full[kind].join(', ')}\n  overlay: ${overlay[kind].join(', ')}`);
  }
}

// ---------------------------------------------------------------------------

test('overlay ⊆ full: an uncommitted service edit reaches the new table, and omits nothing the certified run finds', { timeout: 600000 }, (t) => {
  const why = preflight();
  if (why) { t.skip(why); return; }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-overlay-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const repo = makeRepo(path.join(work, 'repo'));
  const base = path.join(work, 'base');
  const full = path.join(work, 'full');
  const cache = path.join(work, 'xdg');

  const built = analyze(repo, base, cache);
  assert.ok(built.pack.nodes.some((n) => n.id === 'column:shop_stock.qty'), 'the fixture has no shop_stock column');
  const beforeEdit = fullAnswer(built.pack, [IMPL]);
  assert.equal(beforeEdit.columns.includes('column:shop_stock.qty'), false,
    'the base already reaches shop_stock — the edit below would prove nothing');

  // ---- the edit, UNCOMMITTED ------------------------------------------
  fs.writeFileSync(path.join(repo, IMPL), IMPL_EDITED, 'utf8');

  const resp = mcpChangedImpact(repo, base, cache);
  assertContractShape(resp);
  assert.equal(resp.basis.freshness.verdict, 'provisional-overlay');
  const o = resp.answer.overlay;
  assert.equal(o.applied, true);
  assert.deepEqual(o.parsedFiles, [IMPL], 'only the dirty file should have been re-parsed');
  assert.deepEqual(o.dirtyFiles, [IMPL]);
  assert.ok(o.overlaySessionId && o.docVersions[IMPL], 'the session must name the document version it read');
  assert.ok(o.provisionalEdges >= 0);

  const ov = overlayAnswer(resp);
  assert.ok(ov.columns.includes('column:shop_stock.qty'),
    `the overlay did not re-parse the edit: ${ov.columns.join(', ')}`);
  assert.ok(ov.endpoints.includes('endpoint:GET /item/get'));

  // ---- the same bytes, fully re-analyzed -------------------------------
  const certified = analyze(repo, full, cache);
  assertFullSubsetOfOverlay(fullAnswer(certified.pack, [IMPL]), ov, 'service edit');
  t.diagnostic(`overlay timings ms: ${JSON.stringify(o.timingsMs)}`);
});

test('overlay ⊆ full: a brand-new controller file yields PROVISIONAL rows, and still omits nothing', { timeout: 600000 }, (t) => {
  const why = preflight();
  if (why) { t.skip(why); return; }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-overlay-new-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const repo = makeRepo(path.join(work, 'repo'));
  const base = path.join(work, 'base');
  const full = path.join(work, 'full');
  const cache = path.join(work, 'xdg');

  analyze(repo, base, cache);
  // An UNTRACKED new file plus a modification to a tracked one.
  fs.writeFileSync(path.join(repo, IMPL), IMPL_EDITED, 'utf8');
  fs.writeFileSync(path.join(repo, NEW_CONTROLLER), EXTRA_CONTROLLER, 'utf8');

  const resp = mcpChangedImpact(repo, base, cache);
  assertContractShape(resp);
  assert.equal(resp.basis.freshness.verdict, 'provisional-overlay');
  const o = resp.answer.overlay;
  assert.deepEqual(o.parsedFiles.sort(), [NEW_CONTROLLER, IMPL].sort());
  assert.ok(o.provisionalIds.endpoints.includes('endpoint:GET /extra/get'),
    `the new endpoint is not marked provisional: ${JSON.stringify(o.provisionalIds)}`);

  const fresh = resp.answer.upstreamEndpoints.find((e) => e.id === 'GET /extra/get');
  assert.ok(fresh, 'the new endpoint is missing from the answer');
  assert.equal(fresh.provisional, true);
  const old = resp.answer.upstreamEndpoints.find((e) => e.id === 'GET /item/get');
  assert.equal(old.provisional, undefined, 'an endpoint the base already had must not be marked provisional');

  const certified = analyze(repo, full, cache);
  assertFullSubsetOfOverlay(fullAnswer(certified.pack, [IMPL, NEW_CONTROLLER]), overlayAnswer(resp), 'new controller');
});

test('overlay ⊆ full: a deleted file drops its endpoint from the overlay exactly as a re-analysis does', { timeout: 600000 }, (t) => {
  const why = preflight();
  if (why) { t.skip(why); return; }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-overlay-del-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const repo = makeRepo(path.join(work, 'repo'));
  const base = path.join(work, 'base');
  const cache = path.join(work, 'xdg');

  analyze(repo, base, cache);
  fs.rmSync(path.join(repo, CONTROLLER));

  const resp = mcpChangedImpact(repo, base, cache, { files: [IMPL] });
  assertContractShape(resp);
  const o = resp.answer.overlay;
  assert.deepEqual(o.droppedFiles, [CONTROLLER]);
  const eps = resp.answer.upstreamEndpoints.map((e) => e.id);
  assert.equal(eps.includes('GET /item/get'), false,
    `the deleted controller still supplies an endpoint: ${eps.join(', ')}`);
});

test('a frontend edit: the routes the .vue now calls, and the columns they reach', { timeout: 600000 }, (t) => {
  const why = preflight();
  if (why) { t.skip(why); return; }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-overlay-web-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const repo = makeRepo(path.join(work, 'repo'));
  const base = path.join(work, 'base');
  const full = path.join(work, 'full');
  const cache = path.join(work, 'xdg');

  const built = analyze(repo, base, cache);
  assert.ok(built.pack.edges.some((e) => e.type === 'CALLS_HTTP' && e.to === 'endpoint:GET /item/get'),
    'the base frontend does not reach the backend route, so nothing below would mean anything');
  assert.equal(built.pack.nodes.some((n) => n.id === `symbol:${VIEW}#load`), false,
    'the base view has no HTTP call yet');

  // ---- the edit, UNCOMMITTED: the view starts calling the API ----------
  fs.writeFileSync(path.join(repo, VIEW), VIEW_EDITED, 'utf8');

  const resp = mcpChangedImpact(repo, base, cache);
  assertContractShape(resp);
  assert.equal(resp.basis.freshness.verdict, 'provisional-overlay');
  const o = resp.answer.overlay;
  assert.equal(o.applied, true);
  assert.deepEqual(o.parsedWebFiles, [VIEW], 'only the edited frontend file should have been re-read');
  assert.deepEqual(o.parsedFiles, [], 'a frontend edit costs the java lane nothing');

  // The frontend function is in the answer, and it is provisional: no certified
  // run has ever seen it.
  assert.deepEqual(resp.answer.touched.webSymbols, [`${VIEW}#load`]);
  assert.ok(o.provisionalIds.symbols.includes(`symbol:${VIEW}#load`),
    `the new frontend function is not marked provisional: ${JSON.stringify(o.provisionalIds.symbols)}`);
  assert.deepEqual(resp.answer.touched.symbols, [], 'a frontend function is not a java symbol');

  // The blast radius of a frontend edit runs DOWN: the route it calls, and the
  // columns that route reaches.
  assert.deepEqual(resp.answer.calledEndpoints.map((e) => e.id), ['GET /item/get']);
  assert.deepEqual(resp.answer.downstreamColumns.map((c) => c.id).sort(),
    ['shop_item.id', 'shop_item.name']);
  assert.deepEqual(resp.answer.upstreamEndpoints, [], 'nothing in this graph calls a screen');
  // ...and the edited file is no longer reported as "impact unknown".
  assert.equal(resp.answer.files.unmatched.includes(VIEW), false);
  assert.deepEqual(resp.answer.files.matched, [VIEW]);


  // Nothing the certified re-analysis of the same bytes finds is missing here.
  const certified = analyze(repo, full, cache);
  const g = loadPack(certified.pack, { verifyDigest: true });
  const fullR = changeImpact(g, [VIEW], { mode: 'conservative' });
  assert.deepEqual(fullR.calledEndpoints.map((e) => e.id), ['endpoint:GET /item/get']);
  assert.deepEqual(
    fullR.downstreamColumns.map((c) => c.id).filter((x) => !resp.answer.downstreamColumns.map((c) => `column:${c.id}`).includes(x)),
    [], 'the full re-analysis reports columns the overlay omitted');

  t.diagnostic(`one edited .vue, overlay timings ms: ${JSON.stringify(o.timingsMs)}`);
  assert.ok(o.timingsMs.total < 5000, `the overlay took ${o.timingsMs.total} ms for one edited .vue`);

  // A frontend file the lane READ that carries no HTTP call is reported as read
  // and empty, not as "we cannot say": it was looked at, and there was nothing
  // in it. A template-only edit to the original view is exactly that case.
  fs.writeFileSync(path.join(repo, VIEW), FILES[VIEW].replace('class="items"', 'class="items is-wide"'), 'utf8');
  const back = mcpChangedImpact(repo, base, cache);
  assert.deepEqual(back.answer.overlay.parsedWebFiles, [VIEW]);
  assert.deepEqual(back.answer.files.readNoFacts, [VIEW]);
  assert.equal(back.answer.files.unmatched.includes(VIEW), false,
    'a file this lane read is never "impact unknown"');
  assert.deepEqual(back.answer.touched.webSymbols, []);
});

test('a backend edit: every affected route says how many frontend functions call it', { timeout: 600000 }, (t) => {
  const why = preflight();
  if (why) { t.skip(why); return; }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-overlay-front-count-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const repo = makeRepo(path.join(work, 'repo'));
  const base = path.join(work, 'base');
  const cache = path.join(work, 'xdg');

  analyze(repo, base, cache);
  fs.writeFileSync(path.join(repo, IMPL), IMPL_EDITED, 'utf8');

  const resp = mcpChangedImpact(repo, base, cache);
  assertContractShape(resp);
  const row = resp.answer.upstreamEndpoints.find((e) => e.id === 'GET /item/get');
  assert.ok(row, 'the affected route is missing from the answer');
  assert.equal(row.frontendCalls, 1,
    'the route the edit affects is called by one frontend function, and the row must say so');
  assert.equal('calledEndpoints' in resp.answer, false,
    'no frontend file was edited, so the question does not apply and the field is absent');
});

test('discard on commit: committing the edit makes the answer `behind`, and a re-analysis brings it back to `current`', { timeout: 600000 }, (t) => {
  const why = preflight();
  if (why) { t.skip(why); return; }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-overlay-commit-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const repo = makeRepo(path.join(work, 'repo'));
  const base = path.join(work, 'base');
  const cache = path.join(work, 'xdg');

  analyze(repo, base, cache);
  fs.writeFileSync(path.join(repo, IMPL), IMPL_EDITED, 'utf8');
  const dirty = mcpChangedImpact(repo, base, cache);
  assert.equal(dirty.basis.freshness.verdict, 'provisional-overlay');

  // ---- commit: §10.2 says the overlay is DISCARDED --------------------
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'ship the edit']);
  const after = mcpChangedImpact(repo, base, cache);
  assertContractShape(after);
  assert.equal(after.basis.freshness.verdict, 'behind');
  assert.equal(after.answer.overlay.applied, false);
  assert.equal(after.answer.overlay.state, 'stale-commit');
  const lim = after.limits.find((l) => l.scope === 'overlay');
  assert.ok(lim && /cascade analyze/.test(lim.reason), `the behind answer must name the cure, got: ${JSON.stringify(after.limits)}`);
  for (const e of after.answer.upstreamEndpoints) {
    assert.equal(e.provisional, undefined, 'a discarded overlay may not leave provisional rows behind');
  }

  // ---- re-analyze (incremental): the pack describes HEAD again --------
  const again = analyze(repo, base, cache);
  assert.equal(again.pack.meta.incremental.mode, 'incremental');
  const current = mcpChangedImpact(repo, base, cache);
  assertContractShape(current);
  assert.equal(current.basis.freshness.verdict, 'current');
  assert.equal(current.answer.overlay.state, 'clean');
  // and the committed edit is now certified, not provisional
  const certified = fullAnswer(again.pack, [IMPL]);
  assert.ok(certified.columns.includes('column:shop_stock.qty'));
});

test('overlay-stale: with no fact index beside the pack the overlay refuses, and says how to fix it', { timeout: 600000 }, (t) => {
  const why = preflight();
  if (why) { t.skip(why); return; }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-overlay-stale-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const repo = makeRepo(path.join(work, 'repo'));
  const base = path.join(work, 'base');
  const cache = path.join(work, 'xdg');

  analyze(repo, base, cache);
  fs.writeFileSync(path.join(repo, IMPL), IMPL_EDITED, 'utf8');
  fs.rmSync(path.join(base, 'facts-index.json'));

  const r = mcpChangedImpact(repo, base, cache);
  assert.equal(r.isError, true, 'a missing fact cache must be an error, not a quietly pre-edit answer');
  assert.match(r.text, /\[overlay-stale\]/);
  assert.match(r.text, /cascade analyze/);

  // The CLI says the same thing and points at the labelled fallback.
  const cliRun = cli(['impact', '--pack', base], cache);
  assert.notEqual(cliRun.status, 0);
  assert.match(cliRun.stderr, /overlay unavailable \[overlay-stale\]/);
  assert.match(cliRun.stderr, /base-only/);

  const fallback = cli(['impact', '--pack', base, '--mode', 'base-only'], cache);
  assert.equal(fallback.status, 0, fallback.stderr);
  assert.match(fallback.stdout, /mode base-only: this is the BASE pack's answer/);
  assert.equal(/shop_stock\.qty/.test(fallback.stdout), false, 'base-only must not know about the uncommitted edit');
});
