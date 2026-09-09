// viewer_fixtures.mjs — the projects the page is tested against, and the real
// `cascade view` server that serves them.
//
// Four packs, built here rather than analyzed: `alpha` and `beta` are one table
// each (which project the page asks about), `gamma` carries the Java axis (a
// route, a service, a mapper, a table) and `delta` the screen axis (a Vue
// screen calling an api module calling a route). Between them every tool the
// page can call has a real answer, and every answer is the ENGINE's — the
// server here is the one `cascade view` starts, over the same catalog the AI
// talks to.
//
// It lives in a helper because two test files need the same server: the one
// that asks the page questions, and the one that records what it draws.

import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { buildGraph } from '../../src/core/graph.mjs';
import { buildGraphFromSql } from '../../src/adapters/sql_bridge.mjs';
import { addJavaFacts } from '../../src/adapters/java_bridge.mjs';
import { projectPack, loadPack } from '../../src/core/pack.mjs';
import { createProjectHost } from '../../src/mcp/projects.mjs';
import { toolList } from '../../src/mcp/catalog.mjs';
import { serveHttp } from '../../src/mcp/http.mjs';
import { computeTrust } from '../../src/core/trust.mjs';
import { readSourceFor } from '../../src/viewer/source.mjs';
import { ENGINE_ROOT } from './viewer_page.mjs';

// ---------------------------------------------------------------------------
// A real two-project viewer server for the page to talk to
// ---------------------------------------------------------------------------

const PROJECTS = [
  { id: 'alpha', table: 'alpha_order', column: 'total' },
  { id: 'beta', table: 'beta_invoice', column: 'amount' },
  // RM27: the browse rail has nothing to list on Flow without a code axis, and
  // nothing to sort with one table. `gamma` is that pack, and it is served ONLY
  // to the tests that name it, so nothing else in this file changes.
  { id: 'gamma', table: 'gamma_order', column: 'total', java: true },
  // RM31: a pack with the SCREEN AXIS, so the page's frontend end has something
  // to draw. Served only to the tests that name it, like gamma.
  { id: 'delta', table: 'delta_rows', column: 'status', web: true },
];

// gamma, in one picture:
//   GET  /order/{id}   -> GController#get  -> GService.load -> GMapper.selectOrder  (gamma_order)
//   POST /order/save   -> GController#save -> GService.save -> GMapper.updateOrder  (gamma_order)
//                                                           -> GMapper.insertItem  (gamma_item)
//   GET  /admin/ping   -> AController#ping -> (calls nothing)
// so gamma_order is the busiest table AND the one the most endpoints reach,
// POST /order/save is the endpoint that ends at the most tables, and
// gamma_audit is a table no statement touches.
function gammaCatalog() {
  return [
    { kind: 'table', schema: null, table: 'gamma_order', comment: 'the orders table' },
    { kind: 'column', schema: null, table: 'gamma_order', column: 'id', type: 'INT', comment: 'primary key', pk: true },
    { kind: 'column', schema: null, table: 'gamma_order', column: 'total', type: 'DECIMAL(10,2)', comment: 'gamma money' },
    { kind: 'table', schema: null, table: 'gamma_item', comment: null },
    { kind: 'column', schema: null, table: 'gamma_item', column: 'order_id', type: 'INT', comment: null },
    { kind: 'table', schema: null, table: 'gamma_audit', comment: null },
    { kind: 'column', schema: null, table: 'gamma_audit', column: 'id', type: 'INT', comment: null, pk: true },
  ];
}
function gammaLineage() {
  return [
    { kind: 'lineage', namespace: 'com.g.GMapper', id: 'selectOrder', type: 'select',
      tables: [{ table: 'gamma_order', access: 'read' }],
      columns: [{ table: 'gamma_order', column: 'id', access: 'read' }, { table: 'gamma_order', column: 'total', access: 'read' }],
      file: 'GMapper.xml', line: 10 },
    { kind: 'lineage', namespace: 'com.g.GMapper', id: 'updateOrder', type: 'update',
      tables: [{ table: 'gamma_order', access: 'write' }],
      columns: [{ table: 'gamma_order', column: 'total', access: 'write' }],
      file: 'GMapper.xml', line: 20 },
    { kind: 'lineage', namespace: 'com.g.GMapper', id: 'insertItem', type: 'insert',
      tables: [{ table: 'gamma_item', access: 'write' }],
      columns: [{ table: 'gamma_item', column: 'order_id', access: 'write' }],
      file: 'GMapper.xml', line: 30 },
  ];
}
function gammaJava() {
  return [
    { kind: 'type', fqn: 'com.g.GController', typeKind: 'class', package: 'com.g', file: 'src/GController.java', implements: [] },
    { kind: 'type', fqn: 'com.g.AController', typeKind: 'class', package: 'com.g', file: 'src/AController.java', implements: [] },
    { kind: 'type', fqn: 'com.g.GService', typeKind: 'interface', package: 'com.g', file: 'src/GService.java', implements: [] },
    { kind: 'type', fqn: 'com.g.GServiceImpl', typeKind: 'class', package: 'com.g', file: 'src/GServiceImpl.java', implements: ['GService'] },
    { kind: 'type', fqn: 'com.g.GMapper', typeKind: 'interface', package: 'com.g', file: 'src/GMapper.java', implements: [] },
    { kind: 'method', fqn: 'com.g.GController#get', owner: 'com.g.GController', paramCount: 1, line: 20 },
    { kind: 'method', fqn: 'com.g.GController#save', owner: 'com.g.GController', paramCount: 1, line: 30 },
    { kind: 'method', fqn: 'com.g.AController#ping', owner: 'com.g.AController', paramCount: 0, line: 9 },
    { kind: 'method', fqn: 'com.g.GServiceImpl#load', owner: 'com.g.GServiceImpl', paramCount: 1, line: 12 },
    { kind: 'method', fqn: 'com.g.GServiceImpl#save', owner: 'com.g.GServiceImpl', paramCount: 1, line: 22 },
    { kind: 'method', fqn: 'com.g.GMapper#selectOrder', owner: 'com.g.GMapper', paramCount: 1, line: 5 },
    { kind: 'method', fqn: 'com.g.GMapper#updateOrder', owner: 'com.g.GMapper', paramCount: 1, line: 7 },
    { kind: 'method', fqn: 'com.g.GMapper#insertItem', owner: 'com.g.GMapper', paramCount: 1, line: 9 },
    { kind: 'call', from: 'com.g.GController#get', receiver: 's', method: 'load', toTypeSimple: 'GService' },
    { kind: 'call', from: 'com.g.GController#save', receiver: 's', method: 'save', toTypeSimple: 'GService' },
    { kind: 'call', from: 'com.g.GServiceImpl#load', receiver: 'm', method: 'selectOrder', toTypeSimple: 'GMapper' },
    { kind: 'call', from: 'com.g.GServiceImpl#save', receiver: 'm', method: 'updateOrder', toTypeSimple: 'GMapper' },
    { kind: 'call', from: 'com.g.GServiceImpl#save', receiver: 'm', method: 'insertItem', toTypeSimple: 'GMapper' },
    { kind: 'endpoint', httpMethod: 'GET', path: '/order/{id}', handler: 'com.g.GController#get', line: 20 },
    { kind: 'endpoint', httpMethod: 'POST', path: '/order/save', handler: 'com.g.GController#save', line: 30 },
    { kind: 'endpoint', httpMethod: 'GET', path: '/admin/ping', handler: 'com.g.AController#ping', line: 9 },
  ];
}

// THE WORKING TREE the source pane reads. `cascade view` runs on the repo the
// pack was built from and /api/source reads the file on disk, so the page's
// pane cannot be tested against a pack alone: these are the two files gamma's
// nodes point at, written for real and read the same way the CLI reads them.
//
// GMapper.xml puts `selectOrder` on lines 3-5 and `updateOrder` on 6-8; the
// Java file puts `get` on line 20, which is the line gamma's endpoint records.
const GAMMA_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<mapper namespace="com.g.GMapper">',
  '  <select id="selectOrder" resultType="Order">',
  '    SELECT id, total FROM gamma_order WHERE id = #{id}',
  '  </select>',
  '  <update id="updateOrder">',
  '    UPDATE gamma_order SET total = #{total} WHERE id = #{id}',
  '  </update>',
  '  <insert id="insertItem">',
  '    INSERT INTO gamma_item (order_id) VALUES (#{orderId})',
  '  </insert>',
  '</mapper>',
  '',
].join('\n');
// THE FRONTEND FILES delta's nodes point at, written for real, because the
// source pane reads the working tree and not the pack. `rows.vue` puts its
// script on line 5 and `getList` on line 8; `rows.js` puts `listRows` on line 3
// and `saveRow` on line 11 — the lines the pack records.
const DELTA_VUE = [
  '<template>',                                    // 1
  '  <div class="rows">{{ rows.length }}</div>',   // 2
  '</template>',                                   // 3
  '',                                              // 4
  '<script>',                                      // 5
  "import { listRows, saveRow } from '@/api/rows'",// 6
  'export default {',                              // 7
  '  getList() {',                                 // 8
  '    return listRows().then((rows) => {',        // 9
  '      this.rows = rows',                        // 10
  '    })',                                        // 11
  '  },',                                          // 12
  '}',                                             // 13
  '</script>',                                     // 14
  '',
].join('\n');
const DELTA_API = [
  "import request from '@/utils/request'",  // 1
  '',                                       // 2
  'export function listRows(query) {',      // 3
  '  return request({',                     // 4
  "    url: '/rows',",                      // 5
  "    method: 'get',",                     // 6
  '    params: query',                      // 7
  '  })',                                   // 8
  '}',                                      // 9
  '',                                       // 10
  'export function saveRow(data) {',        // 11
  '  return request({',                     // 12
  "    url: '/rows/save',",                 // 13
  "    method: 'post',",                    // 14
  '    data',                               // 15
  '  })',                                   // 16
  '}',                                      // 17
  '',
].join('\n');
function gammaController() {
  const lines = ['package com.g;', '', '// a controller, padded so `get` really is on line 20', ''];
  while (lines.length < 19) lines.push('// filler line ' + (lines.length + 1));
  lines.push('    public Order get(long id) {');       // line 20
  lines.push('        return service.load(id);');
  lines.push('    }');
  lines.push('}');
  return lines.join('\n') + '\n';
}

// delta, in one picture — the shape the web bridge and the java bridge really
// produce, hand-written the way test/screens.test.mjs writes its graphs:
//
//   screen:/rows  --RENDERS-->  views/rows.vue#getList  (component)
//     --CALLS--> api/rows.js#listRows --CALLS_HTTP--> GET /rows
//     --CALLS--> api/rows.js#saveRow  --CALLS_HTTP--> POST /rows/save
//   each route --HANDLES--> a controller --MAY_CALL--> a service --MAY_CALL-->
//   a mapper method --IMPLEMENTS_STMT--> a statement --EXECUTES--> delta_rows
//
//   screen:/quiet mounts a component that renders nothing, so it reaches no
//   route: it is a screen the map must NOT draw and the rail must still list.
//
//   A recording confirms GET /rows from /rows: a RUNTIME_ONLY CALLS_HTTP edge
//   straight from the screen, with `observed` on both ends, exactly as
//   src/adapters/har_bridge.mjs writes it. Nothing walks it.
function deltaFacts() {
  const n = (id, extra = {}) => ({ fact: 'node', id, ...extra });
  const e = (from, to, type, grade, evidence) => ({ fact: 'edge', from, to, type, grade, ...(evidence ? { evidence } : {}) });
  return [
    n('screen:/rows', { path: '/rows', label: '/rows', title: 'Rows', group: 'rows', lane: 'web',
      component: 'src/views/rows.vue', file: 'src/router/index.js', line: 12, source: 'router', observed: true }),
    n('screen:/quiet', { path: '/quiet', label: '/quiet', group: 'quiet', lane: 'web',
      component: 'src/views/quiet.vue', file: 'src/router/index.js', line: 20, source: 'router' }),
    n('symbol:src/views/rows.vue#getList', { file: 'src/views/rows.vue', line: 8, lane: 'web', component: true }),
    n('symbol:src/api/rows.js#listRows', { file: 'src/api/rows.js', line: 3, lane: 'web' }),
    n('symbol:src/api/rows.js#saveRow', { file: 'src/api/rows.js', line: 11, lane: 'web' }),
    n('endpoint:GET /rows', { path: '/rows', httpMethod: 'GET', handler: 'com.d.RowsController#list', file: 'src/RowsController.java', line: 14, observed: true }),
    n('endpoint:POST /rows/save', { path: '/rows/save', httpMethod: 'POST', handler: 'com.d.RowsController#save', file: 'src/RowsController.java', line: 22 }),
    n('symbol:com.d.RowsController#list', { owner: 'com.d.RowsController', file: 'src/RowsController.java', line: 14 }),
    n('symbol:com.d.RowsController#save', { owner: 'com.d.RowsController', file: 'src/RowsController.java', line: 22 }),
    n('symbol:com.d.RowsService#list', { owner: 'com.d.RowsService', file: 'src/RowsService.java', line: 7 }),
    n('symbol:com.d.RowsService#save', { owner: 'com.d.RowsService', file: 'src/RowsService.java', line: 15 }),
    n('symbol:com.d.RowsMapper#selectRows', { owner: 'com.d.RowsMapper', file: 'src/RowsMapper.java', line: 4, mapperMethod: true }),
    n('symbol:com.d.RowsMapper#updateRows', { owner: 'com.d.RowsMapper', file: 'src/RowsMapper.java', line: 6, mapperMethod: true }),
    n('statement:com.d.RowsMapper.selectRows', { statementType: 'select', file: 'RowsMapper.xml', line: 3 }),
    n('statement:com.d.RowsMapper.updateRows', { statementType: 'update', file: 'RowsMapper.xml', line: 9 }),
    n('table:delta_rows', { comment: 'the delta rows' }),
    n('column:delta_rows.id', { type: 'INT', pk: true }),
    n('column:delta_rows.status', { type: 'VARCHAR(16)', comment: 'delta status' }),
    e('screen:/rows', 'symbol:src/views/rows.vue#getList', 'RENDERS', 'EXACT'),
    e('symbol:src/views/rows.vue#getList', 'symbol:src/api/rows.js#listRows', 'CALLS', 'EXACT'),
    e('symbol:src/views/rows.vue#getList', 'symbol:src/api/rows.js#saveRow', 'CALLS', 'EXACT'),
    e('symbol:src/api/rows.js#listRows', 'endpoint:GET /rows', 'CALLS_HTTP', 'SOUND_SET'),
    e('symbol:src/api/rows.js#saveRow', 'endpoint:POST /rows/save', 'CALLS_HTTP', 'SOUND_SET'),
    e('endpoint:GET /rows', 'symbol:com.d.RowsController#list', 'HANDLES', 'EXACT'),
    e('endpoint:POST /rows/save', 'symbol:com.d.RowsController#save', 'HANDLES', 'EXACT'),
    e('symbol:com.d.RowsController#list', 'symbol:com.d.RowsService#list', 'MAY_CALL', 'SOUND_SET'),
    e('symbol:com.d.RowsController#save', 'symbol:com.d.RowsService#save', 'MAY_CALL', 'SOUND_SET'),
    e('symbol:com.d.RowsService#list', 'symbol:com.d.RowsMapper#selectRows', 'MAY_CALL', 'SOUND_SET'),
    e('symbol:com.d.RowsService#save', 'symbol:com.d.RowsMapper#updateRows', 'MAY_CALL', 'SOUND_SET'),
    e('symbol:com.d.RowsMapper#selectRows', 'statement:com.d.RowsMapper.selectRows', 'IMPLEMENTS_STMT', 'EXACT'),
    e('symbol:com.d.RowsMapper#updateRows', 'statement:com.d.RowsMapper.updateRows', 'IMPLEMENTS_STMT', 'EXACT'),
    e('statement:com.d.RowsMapper.selectRows', 'table:delta_rows', 'EXECUTES', 'EXACT', { access: 'read' }),
    e('statement:com.d.RowsMapper.updateRows', 'table:delta_rows', 'EXECUTES', 'EXACT', { access: 'write' }),
    e('statement:com.d.RowsMapper.selectRows', 'column:delta_rows.status', 'READS', 'EXACT'),
    e('statement:com.d.RowsMapper.updateRows', 'column:delta_rows.status', 'WRITES', 'EXACT'),
    e('table:delta_rows', 'column:delta_rows.id', 'DECLARES', 'EXACT'),
    e('table:delta_rows', 'column:delta_rows.status', 'DECLARES', 'EXACT'),
    // The recording. RUNTIME_ONLY, below every mode's floor, walked by nothing.
    e('screen:/rows', 'endpoint:GET /rows', 'CALLS_HTTP', 'RUNTIME_ONLY',
      { rule: 'har', file: 'session.har', count: 2, methods: ['GET'] }),
  ];
}

function packFor(p) {
  if (p.web) {
    return projectPack(buildGraph(deltaFacts()), {
      project: p.id, builtAt: '2026-09-04T00:00:00.000Z', lanes: ['sql', 'java', 'web'],
      axes: { screen: { status: 'shipped', reason: null } },
      laneStats: { web: { screens: { declared: 2, componentUnresolved: 0 } } },
    });
  }
  if (p.java) {
    const g = buildGraphFromSql(gammaCatalog(), gammaLineage());
    addJavaFacts(g, gammaJava(), { packagePrefixes: ['com.g'] });
    return projectPack(g, { project: p.id, builtAt: '2026-09-04T00:00:00.000Z', lanes: ['sql', 'java'] });
  }
  const catalog = [
    { kind: 'table', schema: null, table: p.table, comment: `${p.id} table` },
    { kind: 'column', schema: null, table: p.table, column: 'id', type: 'INT', comment: 'primary key' },
    { kind: 'column', schema: null, table: p.table, column: p.column, type: 'DECIMAL(10,2)', comment: `${p.id} money` },
  ];
  const lineage = [{
    kind: 'lineage', namespace: `${p.id}Mapper`, id: 'selectByPrimaryKey', type: 'select',
    tables: [{ table: p.table, access: 'read' }],
    columns: [{ table: p.table, column: 'id', access: 'read' }, { table: p.table, column: p.column, access: 'read' }],
    file: `${p.id}Mapper.xml`, line: 30,
  }];
  return projectPack(buildGraphFromSql(catalog, lineage), { project: p.id, builtAt: '2026-09-04T00:00:00.000Z', lanes: ['sql'] });
}

export async function startViewer(t, ids = ['alpha', 'beta']) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-page-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const repo = path.join(work, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'GMapper.xml'), GAMMA_XML, 'utf8');
  fs.writeFileSync(path.join(repo, 'src', 'GController.java'), gammaController(), 'utf8');
  fs.mkdirSync(path.join(repo, 'src', 'views'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src', 'api'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'views', 'rows.vue'), DELTA_VUE, 'utf8');
  fs.writeFileSync(path.join(repo, 'src', 'api', 'rows.js'), DELTA_API, 'utf8');
  const entries = PROJECTS.filter((p) => ids.includes(p.id)).map((p) => {
    const dot = path.join(work, p.id, '.cascade');
    fs.mkdirSync(path.join(dot, 'pack'), { recursive: true });
    fs.writeFileSync(path.join(dot, 'pack', 'pack.json'), JSON.stringify(packFor(p)), 'utf8');
    return { id: p.id, dotCascadePath: dot, stack: ['sql'], lastCertifiedAt: '2026-09-04T00:00:00.000Z' };
  });
  const host = createProjectHost({
    registry: entries,
    loadProject: (entry) => {
      const dir = path.join(entry.dotCascadePath, 'pack');
      const pack = JSON.parse(fs.readFileSync(path.join(dir, 'pack.json'), 'utf8'));
      return {
        graph: loadPack(pack, { verifyDigest: true }),
        basis: { project: entry.id, buildDigest: pack.digest, builtAt: pack.meta.builtAt, freshness: { verdict: 'unknown' } },
        trust: computeTrust({}),
        limits: [],
        pack: { project: pack.meta.project, digest: pack.digest, builtAt: pack.meta.builtAt, lanes: pack.meta.lanes, base: null, ddl: null, axes: pack.meta.axes ?? null, laneStats: pack.meta.laneStats ?? null },
        packJson: pack,
        packDir: dir,
      };
    },
  });
  const html = fs.readFileSync(path.join(ENGINE_ROOT, 'viewer', 'index.html'), 'utf8');
  const { server } = await serveHttp({
    http,
    port: 0,
    html,
    deps: {
      toolList,
      callTool: (name, args) => host.callTool(name, args),
      i18nDir: path.join(ENGINE_ROOT, 'viewer', 'i18n'),
      // The page's own scripts and the two engine modules it is served, so a
      // browser pointed at this server would get the whole page and not a shell.
      viewerJsDir: path.join(ENGINE_ROOT, 'viewer', 'js'),
      viewerLibDir: path.join(ENGINE_ROOT, 'src', 'viewer'),
      meta: (project) => {
        const { projectId } = host.resolveProjectArg(project ? { project } : {});
        const ctx = host.ctxFor(projectId);
        return { project: ctx.basis.project, projectId, digest: ctx.packJson.digest, lanes: ctx.packJson.meta.lanes, builtAt: ctx.basis.builtAt, freshness: ctx.basis.freshness, base: null };
      },
      // The same closure bin/cascade.mjs installs, over the working tree above.
      source: (nodeId, project, opts) => {
        const { projectId } = host.resolveProjectArg(project ? { project } : {});
        return readSourceFor(host.ctxFor(projectId).graph, repo, nodeId, {
          readFile: (f) => fs.readFileSync(f, 'utf8'),
          whole: !!(opts && opts.whole),
        });
      },
    },
  });
  t.after(() => new Promise((r) => server.close(r)));
  return { html, base: `http://127.0.0.1:${server.address().port}` };
}
