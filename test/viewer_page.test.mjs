import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { buildGraph } from '../src/core/graph.mjs';
import { buildGraphFromSql } from '../src/adapters/sql_bridge.mjs';
import { addJavaFacts } from '../src/adapters/java_bridge.mjs';
import { projectPack, loadPack } from '../src/core/pack.mjs';
import { createProjectHost } from '../src/mcp/projects.mjs';
import { toolList } from '../src/mcp/catalog.mjs';
import { serveHttp } from '../src/mcp/http.mjs';
import { computeTrust } from '../src/core/trust.mjs';
import { VIEWER_STRINGS } from '../src/viewer/i18n.mjs';
import { readSourceFor } from '../src/viewer/source.mjs';

// The PAGE's own behaviour (SPEC §15 M9), run for real: the viewer's inline
// script is evaluated in a node:vm against a small DOM stub and a REAL viewer
// server holding two projects. No browser is started here — the picture itself
// (canvas mounts, WebGL) is not checked anywhere. What is under
// test is everything a browser is not needed for: which project the page asks
// about, that switching clears the tabs and re-asks, that an answer for the
// project the reader has left is DROPPED, and that a language switch re-renders
// the chrome without asking the server anything again.
//
// WHAT NOTHING IN THIS REPOSITORY CHECKS: the picture itself. No test here
// starts a browser, so a real canvas mount, a WebGL context and the 3D
// renderer are unverified — see the "not verified" list in CHANGELOG.md.

const ENGINE_ROOT = fileURLToPath(new URL('../', import.meta.url));

// ---------------------------------------------------------------------------
// A DOM stub: enough of one for this page, and nothing more
// ---------------------------------------------------------------------------

const VOID_TAGS = new Set(['meta', 'link', 'br', 'input', 'img', 'hr', 'source', 'col']);

class Style {
  constructor() { this._s = {}; }
  setProperty(k, v) { this._s[k] = v; }
  getPropertyValue(k) { return this._s[k] ?? ''; }
}

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.attrs = new Map();
    this.dataset = {};
    this.kids = [];
    this.parentNode = null;
    this.className = '';
    this.id = '';
    this.value = '';
    this.placeholder = '';
    this.title = '';
    this.text = '';
    this.clientWidth = 900;
    this.clientHeight = 620;
    this._style = new Style();
    this._listeners = new Map();
    const self = this;
    this.classList = {
      add: (c) => { const s = self._classes(); s.add(c); self.className = [...s].join(' '); },
      remove: (c) => { const s = self._classes(); s.delete(c); self.className = [...s].join(' '); },
      contains: (c) => self._classes().has(c),
      toggle: (c, force) => {
        const on = force === undefined ? !self._classes().has(c) : !!force;
        if (on) self.classList.add(c); else self.classList.remove(c);
        return on;
      },
    };
  }

  _classes() { return new Set(String(this.className || '').split(/\s+/).filter(Boolean)); }

  get style() { return this._style; }
  set style(v) {
    if (typeof v === 'string') {
      this._style = new Style();
      for (const part of v.split(';')) {
        const i = part.indexOf(':');
        if (i > 0) this._style.setProperty(part.slice(0, i).trim(), part.slice(i + 1).trim());
      }
    } else if (v && typeof v === 'object') this._style = v;
  }

  get textContent() {
    return this.kids.map((k) => (k instanceof El ? k.textContent : k.text)).join('') || this.text;
  }

  set textContent(v) { this.kids = []; this.text = v == null ? '' : String(v); }

  get children() { return this.kids.filter((k) => k instanceof El); }
  get childNodes() { return this.kids; }
  hasChildNodes() { return this.kids.length > 0; }

  append(...kids) {
    for (const k of kids) {
      if (k == null) continue;
      if (k instanceof El) { k.parentNode = this; this.kids.push(k); }
      else this.kids.push({ text: String(k) });
    }
    if (this.text && this.kids.length) this.text = '';
  }

  appendChild(k) { this.append(k); return k; }
  replaceChildren(...kids) { this.kids = []; this.text = ''; this.append(...kids); }
  remove() { if (this.parentNode) this.parentNode.kids = this.parentNode.kids.filter((k) => k !== this); }

  setAttribute(k, v) {
    this.attrs.set(k, String(v));
    if (k === 'id') this.id = String(v);
    else if (k === 'class') this.className = String(v);
    else if (k === 'value') this.value = String(v);
    else if (k === 'placeholder') this.placeholder = String(v);
    else if (k === 'title') this.title = String(v);
    else if (k.startsWith('data-')) this.dataset[camel(k.slice(5))] = String(v);
  }

  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  removeAttribute(k) {
    this.attrs.delete(k);
    if (k === 'disabled') this.disabled = false;
  }
  addEventListener(ev, fn) { if (!this._listeners.has(ev)) this._listeners.set(ev, []); this._listeners.get(ev).push(fn); }
  removeEventListener() {}
  getBoundingClientRect() { return { top: 0, left: 0, width: 900, height: 620, right: 900, bottom: 620 }; }
  focus() {}
  blur() {}
  /** What a real element does: run whatever the page bound to onclick. */
  click() { if (typeof this.onclick === 'function') this.onclick(); }
  scrollIntoView() {}

  /** Every element under this one, this one included. */
  all() {
    const out = [this];
    for (const k of this.kids) if (k instanceof El) out.push(...k.all());
    return out;
  }

  matches(sel) { return matchSimple(this, sel); }
  closest(sel) {
    let n = this;
    while (n) { if (n.matches(sel)) return n; n = n.parentNode; }
    return null;
  }

  querySelectorAll(sel) { return query(this, sel); }
  querySelector(sel) { return query(this, sel)[0] || null; }
}

const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

/** `tag`, `.cls`, `#id`, `[attr]`, `[attr="v"]` and any combination of them. */
function matchSimple(node, sel) {
  const s = sel.trim();
  const parts = s.match(/^([a-zA-Z][\w-]*)?((?:[.#][\w-]+|\[[^\]]+\])*)$/);
  if (!parts) return false;
  if (parts[1] && node.tagName !== parts[1].toUpperCase()) return false;
  for (const bit of (parts[2] || '').match(/[.#][\w-]+|\[[^\]]+\]/g) || []) {
    if (bit[0] === '.') { if (!node._classes().has(bit.slice(1))) return false; }
    else if (bit[0] === '#') { if (node.id !== bit.slice(1)) return false; }
    else {
      const m = bit.slice(1, -1).match(/^([\w-]+)(?:=["']?([^"']*)["']?)?$/);
      if (!m) return false;
      const have = node.attrs.has(m[1]);
      if (!have) return false;
      if (m[2] !== undefined && node.attrs.get(m[1]) !== m[2]) return false;
    }
  }
  return true;
}

/** Descendant combinators only ("#cpaxis button") — all this page ever uses. */
function query(root, sel) {
  const steps = sel.trim().split(/\s+/);
  let pool = root.all().filter((n) => matchSimple(n, steps[0]));
  for (const step of steps.slice(1)) {
    const next = [];
    for (const p of pool) for (const d of p.all()) if (d !== p && matchSimple(d, step)) next.push(d);
    pool = [...new Set(next)];
  }
  return pool;
}

/**
 * A flat-enough parse of the page's static markup: tags, attributes, nesting —
 * AND THE TEXT BETWEEN THEM.
 *
 * The text nodes used to be dropped, and it cost more than it looked like it
 * would: `<option selected>6</option>` (both depth pickers) read back as the
 * empty string, so `select.value` was empty, so `Number(byId('fdepth').value)`
 * was 0, so every chain this stub could have drawn came back as a bad-input.
 * No test in this file had ever rendered one. Text is kept here, and
 * `bootPage` below takes an option's TEXT as its value when it has no `value`
 * attribute, which is what a browser does.
 */
function parseBody(html) {
  const bodyStart = html.indexOf('<body>');
  const bodyEnd = html.indexOf('</body>');
  const src = html.slice(bodyStart + '<body>'.length, bodyEnd);
  const body = new El('body');
  const stack = [body];
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>])*)>/g;
  let m;
  let at = 0;
  /** The run of text that ends where the next tag begins. */
  const text = (upTo) => {
    const run = src.slice(at, upTo);
    at = upTo;
    if (run !== '') stack[stack.length - 1].append(run);
  };
  while ((m = re.exec(src)) !== null) {
    text(m.index);
    at = re.lastIndex;
    if (m[0].startsWith('<!--')) continue;
    const [, close, tag, attrText] = m;
    const lower = tag.toLowerCase();
    if (lower === 'script' || lower === 'style') {
      if (!close) {
        const end = src.indexOf(`</${lower}>`, re.lastIndex);
        re.lastIndex = end < 0 ? src.length : end + lower.length + 3;
        at = re.lastIndex;
      }
      continue;
    }
    if (close) { if (stack.length > 1) stack.pop(); continue; }
    const node = new El(lower);
    for (const a of (attrText || '').matchAll(/([\w:-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      const name = a[1];
      if (name === '/') continue;
      node.setAttribute(name, a[2] ?? a[3] ?? a[4] ?? '');
    }
    stack[stack.length - 1].append(node);
    const selfClosing = (attrText || '').trim().endsWith('/');
    if (!VOID_TAGS.has(lower) && !selfClosing) stack.push(node);
  }
  return body;
}

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

async function startViewer(t, ids = ['alpha', 'beta']) {
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

// ---------------------------------------------------------------------------
// The two themes, read out of the page's own stylesheet
// ---------------------------------------------------------------------------

/** Every custom property one `[data-theme="…"]` block declares, as a map. */
function themeTokens(html, theme) {
  const m = html.match(new RegExp(`\\[data-theme="${theme}"\\]\\s*\\{([^}]*)\\}`));
  assert.ok(m, `viewer/index.html declares no [data-theme="${theme}"] block`);
  const out = {};
  for (const decl of m[1].split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const name = decl.slice(0, i).trim();
    if (!name.startsWith('--')) continue;
    out[name] = decl.slice(i + 1).trim();
  }
  return out;
}

/** What a browser's computed value would be: `var()` references substituted. */
function resolveVars(tok, value) {
  let v = String(value);
  for (let i = 0; i < 5 && v.includes('var(--'); i++) {
    v = v.replace(/var\((--[\w-]+)\)/g, (_, n) => tok[n] ?? '');
  }
  return v;
}

/** WCAG 2.x relative luminance and contrast ratio, from #rrggbb. */
function luminance(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex).trim());
  assert.ok(m, `not a hex colour: ${hex}`);
  const n = parseInt(m[1], 16);
  const chan = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * chan((n >> 16) & 255) + 0.7152 * chan((n >> 8) & 255) + 0.0722 * chan(n & 255);
}
function contrast(fg, bg) {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// ---------------------------------------------------------------------------
// Boot the page inside the stub
// ---------------------------------------------------------------------------

/**
 * A CHAINABLE NOTHING, standing in for the vendored force-graph bundle.
 *
 * The picture itself is still not checked here (no canvas, no layout, no
 * WebGL): what this buys is the code path BEFORE the canvas — the model the
 * page builds out of a `map` answer, the chips beside it and the counts under
 * it, which without a renderer never run at all because `drawMap` stops at
 * `mapHas2D()`. Every method returns the same object, so the whole builder
 * chain in mountMap2D works and every callback it is handed is simply kept.
 */
function fakeForceGraph() {
  const api = new Proxy(function self() { return api; }, {
    get: (_t, k) => (k === 'then' ? undefined : () => api),
    apply: () => api,
  });
  return function ForceGraph() { return api; };
}

async function bootPage(t, { hash = '', search = '', storage = {}, ids, renderer = false } = {}) {
  const { html, base } = await startViewer(t, ids);
  const body = parseBody(html);
  // What a browser does with `<option value="x" selected>`: the select reports
  // that option's value — and where the option has no `value` attribute, its
  // own TEXT (`<option selected>6</option>`, both depth pickers).
  for (const sel of body.querySelectorAll('select')) {
    const chosen = sel.children.find((o) => o.attrs.has('selected')) || sel.children[0];
    if (!chosen) continue;
    const v = chosen.getAttribute('value');
    const value = v != null && v !== '' ? v : chosen.textContent.trim();
    if (value) sel.value = value;
  }
  const documentElement = new El('html');
  const byId = new Map();
  for (const n of body.all()) if (n.id) byId.set(n.id, n);

  const calls = [];
  const realFetch = globalThis.fetch;
  const store = new Map(Object.entries(storage));

  const location = { search, hash, href: base + '/', pathname: '/' };
  const docListeners = new Map();
  const sandbox = {
    console,
    URL, URLSearchParams, TextEncoder, TextDecoder,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    requestAnimationFrame: (fn) => setTimeout(() => fn(0), 0),
    cancelAnimationFrame: (h) => clearTimeout(h),
    performance,
    location,
    history: { replaceState: (a, b, h) => { location.hash = h; }, pushState: (a, b, h) => { location.hash = h; }, back() {} },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
    },
    fetch: (url, opts) => {
      calls.push({ url: String(url), body: opts && opts.body ? JSON.parse(opts.body) : null });
      return realFetch(base + url, opts);
    },
    // The page reads EVERY colour it draws with — CSS, inline SVG and each of
    // the three canvas renderers — out of a custom property on <html>. So the
    // stub answers out of the page's own [data-theme] blocks, for whichever
    // theme is set: that is what makes the accessor testable here at all.
    getComputedStyle: () => {
      const tok = themeTokens(html, documentElement.getAttribute('data-theme') || 'signal');
      return { getPropertyValue: (k) => resolveVars(tok, tok[k] ?? '') };
    },
    document: {
      documentElement,
      body,
      createElement: (tag) => new El(tag),
      createElementNS: (ns, tag) => new El(tag),
      getElementById: (id) => byId.get(id) || null,
      querySelector: (sel) => body.querySelector(sel),
      querySelectorAll: (sel) => body.querySelectorAll(sel),
      // KEPT, not swallowed: the page has ONE Escape rule and it lives on the
      // document, so a test that cannot fire one cannot see it.
      addEventListener: (evName, fn) => {
        if (typeof fn !== 'function') return;
        if (!docListeners.has(evName)) docListeners.set(evName, []);
        docListeners.get(evName).push(fn);
      },
      removeEventListener: () => {},
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  // Window listeners are KEPT, not swallowed: the Graph pane's height is
  // re-measured on `resize`, and a test that cannot fire one cannot see it.
  const winListeners = new Map();
  sandbox.window.addEventListener = (evName, fn) => {
    if (typeof fn !== 'function') return;
    if (!winListeners.has(evName)) winListeners.set(evName, []);
    winListeners.get(evName).push(fn);
  };
  sandbox.window.removeEventListener = () => {};
  sandbox.window.innerWidth = 1400;
  sandbox.window.innerHeight = 900;
  if (renderer) sandbox.window.ForceGraph = fakeForceGraph();

  const ctx = vm.createContext(sandbox);
  const script = html.slice(html.lastIndexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));
  vm.runInContext(script, ctx, { filename: 'viewer/index.html' });
  // The page's init() is async (it fetches its catalogues, the project list,
  // the meta and the Overview): let those settle.
  await settle(ctx);
  /** Fire one window event at every listener the page registered for it. */
  const fireWindow = (evName) => {
    for (const fn of winListeners.get(evName) || []) fn({ type: evName });
  };
  /** Fire one document event at every listener the page registered for it. */
  const fireDoc = (evName, extra = {}) => {
    for (const fn of [...(docListeners.get(evName) || [])]) {
      fn({ type: evName, target: body, preventDefault() {}, stopPropagation() {}, ...extra });
    }
  };
  return { ctx, sandbox, body, byId, calls, base, store, html, fireWindow, fireDoc };
}

/** Let every pending microtask + timer round the page started actually run. */
async function settle(ctx, rounds = 12) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 5));
  void ctx;
}

const ev = (ctx, expr) => vm.runInContext(expr, ctx);

// ---------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------

test('the page boots against a two-project server, picks a project and says which in the URL', async (t) => {
  const { ctx, byId, calls } = await bootPage(t);

  assert.equal(ev(ctx, 'STATE.project'), 'alpha', 'with nothing to go on it takes the first served project');
  assert.equal(ev(ctx, "STATE.projects.map(p=>p.id).join()"), 'alpha,beta');
  assert.equal(ev(ctx, 'location.hash'), '#p=alpha&tab=overview');
  assert.equal(ev(ctx, 'STATE.tab'), 'overview');

  // The selector is a <select> because there is more than one project.
  const sel = byId.get('projsel');
  assert.equal(sel.classList.contains('hidden'), false);
  assert.deepEqual(sel.children.map((o) => o.value), ['alpha', 'beta']);
  assert.equal(byId.get('projone').classList.contains('hidden'), true);
  assert.equal(byId.get('projnone').classList.contains('hidden'), true);

  // Every call carried the project — nothing was left for the server to guess.
  const apiCalls = calls.filter((c) => c.url.startsWith('/api/call'));
  assert.ok(apiCalls.length > 0);
  for (const c of apiCalls) assert.equal(c.body.project, 'alpha', `${c.body.name} did not carry the project`);
  assert.ok(calls.some((c) => c.url === '/api/projects'));
  assert.ok(calls.some((c) => c.url.startsWith('/api/meta?project=alpha')));

  // The masthead's DATELINE says which pack answered, from /api/meta: the pack
  // id is its first field (the selector), then which analyzers ran. Since RM36
  // the BUILD identity is one click behind it, closed at rest, and the values
  // are written into it whether it is open or not.
  assert.equal(byId.get('projsel').value, 'alpha');
  assert.equal(byId.get('mlanes').textContent, 'sql');
  assert.equal(byId.get('mbuild').classList.contains('hidden'), true, 'the build detail is closed at rest');
  assert.match(byId.get('mdigest').textContent, /^\w/, 'and the digest is written into it all the same');
  assert.ok(byId.get('mbase'), 'the build detail carries a base-commit field');
  assert.equal(byId.get('mbase').closest('#mbuild') != null, true, '...inside the build detail');
  // And the freshness chip says nothing when there is nothing to warn about:
  // `unknown` is a pack with no git base to compare against, not a failure.
  assert.equal(byId.get('mfresh').textContent, '', 'the resting verdict is not printed at all');
  assert.match(byId.get('mfreshchip').title, /freshness unknown/, "the engine's verdict is in the tooltip");
  assert.equal(byId.get('proj').textContent, '', 'the note under the line is for loading and refusals only');
});

test('a deep link decides the project and the tab; localStorage is the fallback', async (t) => {
  const deep = await bootPage(t, { hash: '#p=beta&tab=graph' });
  assert.equal(ev(deep.ctx, 'STATE.project'), 'beta');
  assert.equal(ev(deep.ctx, 'STATE.tab'), 'graph');
  assert.equal(deep.store.get('cascade.viewer.project'), 'beta');
  for (const c of deep.calls.filter((x) => x.url.startsWith('/api/call'))) assert.equal(c.body.project, 'beta');

  const remembered = await bootPage(t, { storage: { 'cascade.viewer.project': 'beta' } });
  assert.equal(ev(remembered.ctx, 'STATE.project'), 'beta');

  // A project this server does not serve is ignored, not sent.
  const bogus = await bootPage(t, { hash: '#p=gamma&tab=overview' });
  assert.equal(ev(bogus.ctx, 'STATE.project'), 'alpha');
});

test('switching project clears every tab, re-asks, and never leaves a renderer behind', async (t) => {
  // The rail is COLLAPSED by default, and collapsed it says nothing that tells
  // one pack from another; the digest is in its `basis` block. This reader has
  // that block open from last time, so the rail below really does name a pack.
  const { ctx, byId, calls } = await bootPage(t, { storage: { 'cascade.viewer.fold.rail.overview.basis': '1' } });
  assert.equal(ev(ctx, 'OV.resp !== null'), true, 'the Overview answered for alpha');
  const before = ev(ctx, 'STATE.seq');
  const alphaRail = byId.get('ovside').textContent;   // the rail carries the pack's own digest
  assert.match(alphaRail, /alpha/, 'the remembered fold really did open');

  const sel = byId.get('projsel');
  sel.value = 'beta';
  calls.length = 0;
  sel.onchange({ target: sel });
  // Synchronously, before a single answer can come back: everything the old
  // project left is gone.
  assert.equal(ev(ctx, 'STATE.project'), 'beta');
  assert.equal(ev(ctx, 'STATE.seq') > before, true, 'the sequence moved, so answers in flight are stale');
  assert.equal(ev(ctx, 'OV.resp'), null);
  assert.equal(ev(ctx, 'GMAP.resp'), null);
  assert.equal(ev(ctx, 'GMAP.api'), null, 'the map renderer was torn down');
  assert.equal(ev(ctx, 'GA.api'), null, 'the Around renderer was torn down');
  assert.equal(ev(ctx, 'ERD.api'), null, 'the ERD renderer was torn down');
  assert.equal(ev(ctx, 'CP.resp'), null);
  assert.equal(ev(ctx, 'FLOWV.resp'), null);
  assert.equal(ev(ctx, 'IMPACTV.resp'), null);
  assert.equal(ev(ctx, 'erdData'), null);
  assert.equal(ev(ctx, "GRAPHV.mode"), 'map', 'the Graph tab is put back on the whole-pack map');
  assert.equal(ev(ctx, 'location.hash'), '#p=beta&tab=overview');

  await settle(ctx);
  for (const c of calls.filter((x) => x.url.startsWith('/api/call'))) assert.equal(c.body.project, 'beta');
  assert.ok(calls.some((c) => c.url.startsWith('/api/meta?project=beta')));
  assert.equal(ev(ctx, 'OV.resp.basis.project'), 'beta');
  assert.notEqual(byId.get('ovside').textContent, alphaRail, 'the rail names the other pack now');
  assert.equal(byId.get('projsel').value, 'beta');
  assert.match(byId.get('mdigest').textContent, /^\w/);
});

test('switching while the Graph tab is open leaves ONE picture area, not two', async (t) => {
  // The real canvas count is a browser question, and no test in this repository
  // answers it (nothing here starts a browser); what IS checkable here is that
  // the switch tears both renderers down and re-enters the map with exactly one
  // thing mounted in #gmapwrap.
  const { ctx, byId } = await bootPage(t, { hash: '#p=alpha&tab=graph' });
  const wrap = byId.get('gmapwrap');
  assert.equal(ev(ctx, 'GRAPHV.mode'), 'map');
  assert.equal(wrap.children.length, 1, 'one mount before the switch');

  const sel = byId.get('projsel');
  sel.value = 'beta';
  sel.onchange({ target: sel });
  await settle(ctx);

  assert.equal(ev(ctx, 'STATE.project'), 'beta');
  assert.equal(ev(ctx, 'GRAPHV.mode'), 'map');
  assert.equal(ev(ctx, 'GMAP.api'), null);
  assert.equal(ev(ctx, 'GA.api'), null);
  assert.equal(wrap.children.length, 1, 'still one mount after it — no renderer left behind');
  assert.equal(wrap.children.filter((c) => c.tagName === 'CANVAS').length, 0, 'no vendored renderer in this stub, so no canvas');
});

test('an answer for the project the reader has left is DROPPED, not drawn', async (t) => {
  const { ctx } = await bootPage(t);
  // Start a call as alpha, move to beta while it is in flight, and see what the
  // page does with the reply.
  const outcome = await ev(ctx, `(async()=>{
    const p = api('overview', {});
    STATE.project='beta'; STATE.seq++;
    try { await p; return 'drawn'; }
    catch(e){ return e.stale ? 'dropped' : 'error:'+e.message; }
  })()`);
  assert.equal(outcome, 'dropped');

  // ...and a stale rejection paints no error banner: the banner path checks it.
  assert.equal(ev(ctx, "stale({stale:true})"), true);
  assert.equal(ev(ctx, "stale(new Error('real failure'))"), false);
});

test('the "My edits" panel is per project: changed_impact carries the project too', async (t) => {
  const { ctx, byId, calls } = await bootPage(t, { hash: '#p=beta&tab=explore' });
  calls.length = 0;
  byId.get('edits').onclick();
  await settle(ctx, 4);
  const edits = calls.filter((c) => c.body && c.body.name === 'changed_impact');
  assert.equal(edits.length, 1, 'the button asked the engine exactly once');
  assert.equal(edits[0].body.project, 'beta', 'the working-tree overlay is the one of THIS project');
});

test('the language toggle re-renders the chrome and asks the server for nothing', async (t) => {
  const { ctx, byId, calls, store } = await bootPage(t);
  const tabs = () => byId.get('proj').parentNode.parentNode.querySelectorAll('.tab').map((x) => x.textContent);
  assert.deepEqual(tabs()[0], 'Overview');
  assert.equal(ev(ctx, 'I18N.lang'), 'en');

  const seg = byId.get('langseg');
  assert.deepEqual(seg.children.map((b) => b.className), ['on', '']);
  const koButton = seg.children[1];
  assert.notEqual(koButton.textContent, 'KO', 'the Korean catalogue names itself');

  calls.length = 0;
  koButton.onclick();
  assert.equal(ev(ctx, 'I18N.lang'), 'ko');
  assert.equal(store.get('cascade.viewer.lang'), 'ko');
  assert.equal(calls.length, 0, 'switching language must not re-ask the server');

  // The chrome moved...
  assert.notEqual(tabs()[0], 'Overview');
  assert.match(tabs()[0], /[가-힣]/);
  assert.match(byId.get('edits').textContent, /[가-힣]/);
  // ...and no key was missing while it did.
  assert.equal(ev(ctx, 'JSON.stringify([...I18N.t.missing])'), '[]');
  assert.equal(ev(ctx, 'JSON.stringify([...I18N.t.fellBack])'), '[]');

  // The ANSWER on screen is untouched: the engine's own numbers and words.
  assert.match(byId.get('ovside').textContent, /freshness/, "the engine's honesty block is not translated");

  // Back to English, from the same catalogue, with no fetch either.
  seg.children[0].onclick();
  assert.equal(ev(ctx, 'I18N.lang'), 'en');
  assert.deepEqual(tabs()[0], 'Overview');
  assert.equal(calls.length, 0);
});

test('a language remembered from last time is the one the page boots in', async (t) => {
  const { ctx, byId } = await bootPage(t, { storage: { 'cascade.viewer.lang': 'ko' } });
  assert.equal(ev(ctx, 'I18N.lang'), 'ko');
  assert.match(byId.get('ghintmap').textContent, /[가-힣]/, 'the hints are chrome and are translated');
  // The title block still relays the engine's own values, untranslated.
  assert.equal(byId.get('projsel').value, 'alpha');
  assert.equal(byId.get('mlanes').textContent, 'sql');
});

test('exactly one project: a static label, no selector to pick from', async (t) => {
  const { ctx, byId, calls } = await bootPage(t, { ids: ['beta'] });
  assert.equal(ev(ctx, 'STATE.project'), 'beta');
  assert.equal(byId.get('projsel').classList.contains('hidden'), true, 'no <select> when there is no choice');
  assert.equal(byId.get('projone').classList.contains('hidden'), false);
  assert.equal(byId.get('projone').textContent, 'beta');
  assert.equal(byId.get('projnone').classList.contains('hidden'), true);
  for (const c of calls.filter((x) => x.url.startsWith('/api/call'))) assert.equal(c.body.project, 'beta');
});

test('no project at all: the page says so and names the two commands that fix it', async (t) => {
  const { ctx, byId } = await bootPage(t, { ids: [] });
  assert.equal(ev(ctx, 'STATE.project'), null);
  assert.equal(byId.get('projsel').classList.contains('hidden'), true);
  assert.equal(byId.get('projone').classList.contains('hidden'), true);
  const none = byId.get('projnone');
  assert.equal(none.classList.contains('hidden'), false);
  assert.match(none.textContent, /cascade init/);
  assert.match(none.textContent, /cascade analyze/);
  assert.equal(ev(ctx, 'location.hash'), '#tab=overview', 'no project means no id to put in the hash');
  assert.deepEqual(none.children.filter((c) => c.tagName === 'CODE').map((c) => c.textContent), ['cascade init', 'cascade analyze']);
  // ...and the server's refusal to answer is a banner, not a blank pane.
  assert.match(byId.get('ovcards').textContent + byId.get('proj').textContent, /serves no project/);
});

test('?project= from the start-up line the CLI prints is honoured too', async (t) => {
  const { ctx } = await bootPage(t, { search: '?project=beta' });
  assert.equal(ev(ctx, 'STATE.project'), 'beta');
  assert.equal(ev(ctx, 'location.hash'), '#p=beta&tab=overview');
});

test('the hints keep their emphasis: a catalogue string becomes elements, never HTML', async (t) => {
  const { byId } = await bootPage(t);
  const hint = byId.get('ghintmap');
  // Collapsed, the hint is its LEAD and nothing else — the paragraph that
  // carries the emphasis is not even built yet.
  assert.equal(hint.querySelectorAll('b').length, 0, 'a closed fold builds no body');
  assert.equal(hint.textContent.includes('Around <node>'), false);

  hint.querySelector('button').onclick();   // one activation
  const bold = hint.querySelectorAll('b');
  assert.equal(bold.length, 1);
  assert.equal(bold[0].textContent, 'Around <node>');
  assert.equal(hint.textContent.includes('**'), false, 'the marker itself must not reach the page');
});

test('a language switch re-renders the panels the PAGE authors — Graph map, Impact and ERD — and still asks for nothing', async (t) => {
  const { ctx, byId, calls } = await bootPage(t);

  // The three side panels the page writes in JAVASCRIPT beside an answer,
  // rather than as `data-t` markup. They are the ones that used to stay English
  // while the toolbar around them turned Korean.
  //
  // The Graph map's own PICTURE needs the vendored force-graph bundle, which no
  // vm has; the picture is not what is under test here, the words beside it
  // are, so the answer is fetched and the card drawn from it directly.
  ev(ctx, `(async () => {
    const r = await api('map', {});
    GMAP.resp = r;
    GMAP.nodes = r.answer.nodes.map((n) => ({ id: n.id, kind: n.kind, label: n.label || n.id, degree: 1, data: n }));
    GMAP.byId = new Map(GMAP.nodes.map((n) => [n.id, n]));
    GMAP.sel = null;
    renderMapSide();
  })()`);
  await settle(ctx, 12);
  ev(ctx, 'drawErd()');
  await settle(ctx, 12);
  // Impact walks UP from a column, which this SQL-only fixture does have. The
  // toolbar's own commit path spends a `search` request resolving what was
  // typed; the answer is what this test needs, so it is asked for directly.
  ev(ctx, `(async () => {
    const r = await api('flow', { column: 'alpha_order.total', direction: 'up', depth: 8 });
    IMPACTV.resp = r; IMPACTV.sel = null; IMPACTV.rows = new Map();
    renderChainSide(IMPACTV);
  })()`);
  await settle(ctx, 12);

  const gside = () => byId.get('gside').textContent;
  const erdside = () => byId.get('erdside').textContent;
  const iside = () => byId.get('impactside').textContent;
  const mapleg = () => byId.get('gmapleg').textContent;
  assert.match(gside(), /the whole project/, 'the Graph lead card is drawn');
  assert.match(erdside(), /whole-schema map/, 'the ERD side is drawn');
  assert.match(iside(), /how to read the lines/, 'the Impact side is drawn');
  assert.match(mapleg(), /nodes:/, 'the map legend is drawn');

  calls.length = 0;
  byId.get('langseg').children[1].onclick();   // -> ko
  await settle(ctx, 6);

  // (1) NOTHING was re-asked. The engine's words do not change with the
  //     interface language, so a request here would be waste — and a lie about
  //     what a language toggle does.
  assert.deepEqual(calls, [], `a language switch asked the server for: ${calls.map((c) => c.url).join(', ')}`);

  // (2) ...and the page-authored panels really did move.
  for (const [what, read] of [['Graph lead card', gside], ['ERD side', erdside],
    ['Impact side', iside], ['map legend', mapleg]]) {
    assert.match(read(), /[가-힣]/, `the ${what} is still in English`);
  }
  assert.equal(/the whole project/.test(gside()), false);
  assert.equal(/whole-schema map/.test(erdside()), false);
  assert.equal(/how to read the lines/.test(iside()), false);
  assert.equal(/nodes:/.test(mapleg()), false);

  // (3) The ENGINE's vocabulary inside those same panels is untouched: the
  //     grade names beside the legend are relayed, never translated.
  assert.match(iside(), /EXACT/);
  assert.match(iside(), /SOUND_SET/);
  assert.match(mapleg(), /SOUND_SET/);
  assert.equal(ev(ctx, 'JSON.stringify([...I18N.t.missing])'), '[]');
  assert.equal(ev(ctx, 'JSON.stringify([...I18N.t.fellBack])'), '[]');
});

// ---------------------------------------------------------------------------
// The Flow / Impact lane strip: it has to FIT the pane it is in (RM16b §1)
// ---------------------------------------------------------------------------

/** The page's one <style> block, as text. */
function styleBlock(html) {
  const a = html.indexOf('<style>');
  const b = html.indexOf('</style>', a);
  assert.ok(a >= 0 && b > a, 'no <style> block in viewer/index.html');
  return html.slice(a + '<style>'.length, b);
}

/** The declarations of the LAST rule whose selector list is exactly `sel`. */
function cssRule(css, sel) {
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => m[1].trim().split(/\s*,\s*/).includes(sel));
  assert.ok(rules.length > 0, `no CSS rule for ${sel}`);
  return rules.map((m) => m[2].trim());
}

test('the lane strip carries NO fixed pixel width: the four lanes share the pane', async (t) => {
  const { html } = await startViewer(t);
  const css = styleBlock(html);

  // A lane is a flex child with a floor, never a fixed 252px column: beside the
  // 320px evidence rail four fixed lanes overflowed the box at 1400px and the
  // table lane — the one that answers the question — scrolled off the right.
  const fcol = cssRule(css, '.fcol').join(' ');
  assert.equal(/(?:^|;|\s)width\s*:\s*\d+px/.test(fcol), false,
    `.fcol still carries a fixed pixel width: ${fcol}`);
  assert.match(fcol, /flex\s*:/, '.fcol must flex');
  assert.match(fcol, /min-width\s*:\s*180px/, '.fcol must keep a 180px floor');

  // ...and the strip around them must not demand its content's width, or the
  // flex floor above would simply move the overflow up one level.
  for (const decl of cssRule(css, '.flowwrap')) {
    assert.equal(/min-width\s*:\s*max-content/.test(decl), false,
      `.flowwrap still asks for max-content: ${decl}`);
  }

  // The only pixel width a lane may carry is the CAP on a wide screen, and it
  // is a max-width inside a min-width media query — never a fixed size.
  const capped = css.match(/@media\s*\(min-width:\s*1600px\)\s*\{[^}]*\.fcol\s*\{([^}]*)\}/);
  assert.ok(capped, 'no wide-screen cap for .fcol');
  assert.match(capped[1], /max-width\s*:\s*300px/);
});

test('a rendered lane sets no width of its own — the stylesheet decides', async (t) => {
  const { ctx, byId } = await bootPage(t, { hash: '#p=alpha&tab=impact' });
  await ev(ctx, `(async () => {
    const r = await api('flow', { column: 'alpha_order.total', direction: 'up', depth: 8 });
    IMPACTV.resp = r; IMPACTV.sel = null;
    renderChain(IMPACTV, r);
  })()`);
  await settle(ctx, 8);
  const cols = byId.get('impactwrap').querySelectorAll('.fcol');
  assert.equal(cols.length, 4, 'the target and its three lanes');
  for (const c of cols) {
    assert.equal(c.style.getPropertyValue('width'), '', 'a lane must not be sized inline');
    assert.equal(c.getAttribute('width'), null);
  }
});

// ---------------------------------------------------------------------------
// The lane strip's own words follow the language too (RM16b §3)
// ---------------------------------------------------------------------------

test('a language switch moves the lane HEADINGS and hop captions — and still asks for nothing', async (t) => {
  const { ctx, byId, calls } = await bootPage(t, { hash: '#p=alpha&tab=impact' });
  await ev(ctx, `(async () => {
    const r = await api('flow', { column: 'alpha_order.total', direction: 'up', depth: 8 });
    IMPACTV.resp = r; IMPACTV.sel = null;
    renderChain(IMPACTV, r);
  })()`);
  await settle(ctx, 8);

  const heads = () => byId.get('impactwrap').querySelectorAll('.fcoltitle').map((x) => x.textContent);
  const hops = () => byId.get('impactwrap').querySelectorAll('.fhop').map((x) => x.textContent);
  assert.deepEqual(heads(), ['target', 'mapper statement', 'service layer', 'endpoint']);
  assert.ok(hops().length > 0, 'the walk put rows under at least one hop');
  for (const h of hops()) assert.match(h, /^hop \d/);

  calls.length = 0;
  byId.get('langseg').children[1].onclick();   // -> ko
  await settle(ctx, 6);

  assert.deepEqual(calls, [], `the switch asked the server for: ${calls.map((c) => c.url).join(', ')}`);
  for (const h of heads()) assert.match(h, /[가-힣]/, `a lane heading is still English: ${h}`);
  for (const h of hops()) assert.match(h, /[가-힣]/, `a hop caption is still English: ${h}`);
  assert.equal(ev(ctx, 'JSON.stringify([...I18N.t.missing])'), '[]');
  assert.equal(ev(ctx, 'JSON.stringify([...I18N.t.fellBack])'), '[]');
});

test('a language switch moves the count line under a picture, from the answer in memory', async (t) => {
  const { ctx, byId, calls } = await bootPage(t, { hash: '#p=alpha&tab=graph' });
  // The picture needs the vendored bundle no vm has; the WORDS beside it do not.
  await ev(ctx, `(async () => {
    const r = await api('map', {});
    GMAP.resp = r;
    GMAP.nodes = r.answer.nodes.map((n) => ({ id: n.id, kind: n.kind, label: n.label || n.id, degree: 1, data: n }));
    GMAP.byId = new Map(GMAP.nodes.map((n) => [n.id, n]));
    GMAP.links = []; GMAP.sel = null;
    renderMapCounts(); renderMapChips(); renderMapSide();
  })()`);
  await settle(ctx, 8);

  const counts = () => byId.get('gcounts').textContent;
  const chips = () => byId.get('gchips').textContent;
  assert.match(counts(), /groups/, 'the count line is drawn in English first');
  assert.match(counts(), /lines drawn/);
  assert.match(chips(), /show:/);

  calls.length = 0;
  byId.get('langseg').children[1].onclick();   // -> ko
  await settle(ctx, 6);

  assert.deepEqual(calls, [], `the switch asked the server for: ${calls.map((c) => c.url).join(', ')}`);
  assert.match(counts(), /[가-힣]/, 'the count line is still English');
  assert.equal(/lines drawn/.test(counts()), false);
  assert.match(chips(), /[가-힣]/, 'the kind chips label is still English');
  assert.equal(/show:/.test(chips()), false);
  assert.equal(ev(ctx, 'JSON.stringify([...I18N.t.missing])'), '[]');
  assert.equal(ev(ctx, 'JSON.stringify([...I18N.t.fellBack])'), '[]');
});

test('the ERD stats line is a catalogue sentence, and it discloses a hub-only labelling', async (t) => {
  const { ctx, byId, calls } = await bootPage(t, { hash: '#p=alpha&tab=erd' });
  ev(ctx, 'drawErd()');
  await settle(ctx, 12);
  const leg = () => byId.get('erdleg').textContent;
  assert.match(leg(), /tables drawn/);
  // One table, drawn at rest: far below the cap, so every table is named and
  // there is nothing to disclose.
  assert.equal(ev(ctx, 'ERD.labelAll'), true);
  assert.equal(/busiest tables/.test(leg()), false, 'nothing to disclose below the cap');

  // Above the cap the picture keeps the hub-only level of detail and SAYS so.
  ev(ctx, 'ERD.labelAll=false; ERD.always=new Set(["a","b","c"]); redrawErdLegend();');
  assert.match(leg(), /names on the 3 busiest tables/);

  calls.length = 0;
  byId.get('langseg').children[1].onclick();   // -> ko
  await settle(ctx, 6);
  assert.deepEqual(calls, [], `the switch asked the server for: ${calls.map((c) => c.url).join(', ')}`);
  assert.match(leg(), /[가-힣]/, 'the ERD stats line is still English');
  assert.equal(/tables drawn/.test(leg()), false);
  assert.equal(ev(ctx, 'JSON.stringify([...I18N.t.missing])'), '[]');
});

// ---------------------------------------------------------------------------
// The stats line reports the labels the placer DREW, not the ones asked for
// ---------------------------------------------------------------------------

/** Run one frame with a placer that drops names, and read the stats line back. */
function feedPlacer(ctx, { labelAll, ids, placedIds }) {
  ev(ctx, `
    ERD.nodes = ${JSON.stringify(ids)}.map((id) => ({ id, r: 6, rank: 1, comp: 0 }));
    ERD.byId = new Map(ERD.nodes.map((n) => [n.id, n]));
    ERD.always = new Set(${JSON.stringify(ids)});
    ERD.labelAll = ${labelAll ? 'true' : 'false'};
    ERD.lit = null; ERD.placed = null;
    // The real placer drops a name whose box would land on a neighbour; this
    // one drops the same way, so the accounting under test is the real one.
    gfPlaceLabels = () => new Map(${JSON.stringify(placedIds)}.map((id) => [id, { x: 0, y: 0, size: 10 }]));
    erdFramePre({}, 1);
  `);
}

test('the ERD stats line counts the names that LANDED, in both label modes', async (t) => {
  const { ctx, byId, calls } = await bootPage(t, { hash: '#p=alpha&tab=erd' });
  ev(ctx, 'drawErd()');
  await settle(ctx, 12);
  const leg = () => byId.get('erdleg').textContent;

  // Below the cap, all three names fit: the line has nothing to add.
  feedPlacer(ctx, { labelAll: true, ids: ['a', 'b', 'c'], placedIds: ['a', 'b', 'c'] });
  assert.equal(ev(ctx, 'JSON.stringify(ERD.placed)'), '{"wanted":3,"placed":3}');
  assert.equal(/tables named/.test(leg()), false, 'nothing to disclose when every name fits');

  // ...and when the placer drops one, the line says how many really landed.
  feedPlacer(ctx, { labelAll: true, ids: ['a', 'b', 'c'], placedIds: ['a', 'b'] });
  assert.equal(ev(ctx, 'JSON.stringify(ERD.placed)'), '{"wanted":3,"placed":2}');
  assert.match(leg(), /2 of 3 tables named/);

  // Hub-only mode names the number PLACED, never the number intended.
  feedPlacer(ctx, { labelAll: false, ids: ['a', 'b', 'c'], placedIds: ['a'] });
  assert.equal(ev(ctx, 'JSON.stringify(ERD.placed)'), '{"wanted":3,"placed":1}');
  assert.match(leg(), /names on 1 of the 3 busiest tables/);
  assert.equal(/names on the 3 busiest tables/.test(leg()), false, 'the intended count must not stand alone');

  // With every hub placed it goes back to the plain sentence.
  feedPlacer(ctx, { labelAll: false, ids: ['a', 'b', 'c'], placedIds: ['a', 'b', 'c'] });
  assert.match(leg(), /names on the 3 busiest tables/);

  // A SPOTLIGHT asks for a different set of names entirely: the census is left
  // alone rather than re-counted against a promise this frame is not making.
  feedPlacer(ctx, { labelAll: false, ids: ['a', 'b', 'c'], placedIds: ['a'] });
  ev(ctx, 'ERD.lit={id:"a", nodes:new Set(["a"]), links:new Set()}; gfPlaceLabels=()=>new Map([["a",{x:0,y:0,size:10}]]); erdFramePre({},1);');
  assert.equal(ev(ctx, 'JSON.stringify(ERD.placed)'), '{"wanted":3,"placed":1}', 'a spotlight must not rewrite the resting census');

  // ...and the whole line still moves with the language, asking for nothing.
  ev(ctx, 'ERD.lit=null;');
  feedPlacer(ctx, { labelAll: false, ids: ['a', 'b', 'c'], placedIds: ['a'] });
  calls.length = 0;
  byId.get('langseg').children[1].onclick();   // -> ko
  await settle(ctx, 6);
  assert.deepEqual(calls, [], `the switch asked the server for: ${calls.map((c) => c.url).join(', ')}`);
  assert.match(leg(), /[가-힣]/);
  assert.equal(/busiest tables/.test(leg()), false);
  assert.match(leg(), /1/, 'the placed count survives the translation');
  assert.equal(ev(ctx, 'JSON.stringify([...I18N.t.missing])'), '[]');
  assert.equal(ev(ctx, 'JSON.stringify([...I18N.t.fellBack])'), '[]');
});

// ---------------------------------------------------------------------------
// PROGRESSIVE DISCLOSURE (RM19): glance, then read, then inspect.
//
// The page shows numbers, chips and pictures at rest; one line per item where a
// sentence is owed; and the full text only when the reader asks for it. What is
// under test here is the HONESTY half of that: nothing was deleted on the way,
// every count still stands outside every fold, and one activation is enough to
// reach any full text.
// ---------------------------------------------------------------------------

const VIEWER_STRINGS_EN = VIEWER_STRINGS.en;
const KO_CATALOG = JSON.parse(fs.readFileSync(path.join(ENGINE_ROOT, 'viewer', 'i18n', 'ko.json'), 'utf8'));

test('the evidence rail: the limits chip counts them, and ONE activation puts every reason in the page', async (t) => {
  const { ctx } = await bootPage(t);
  const answers = [
    ['overview', {}],
    ['flow', { column: 'alpha_order.total', direction: 'up', depth: 8 }],
    ['column_impact', { column: 'alpha_order.total', mode: 'both' }],
  ];
  let withLimits = 0;
  for (const [tool, args] of answers) {
    const raw = await ev(ctx, `(async () => {
      const r = await api(${JSON.stringify(tool)}, ${JSON.stringify(args)});
      const rail = honesty(r, 'probe-${tool}');
      const chips = rail.querySelectorAll('button.railchip');
      const before = rail.textContent;
      for (const c of chips) c.onclick();
      return JSON.stringify({ limits: r.limits.length, chips: chips.map((c) => c.textContent),
        before, after: rail.textContent, reasons: r.limits.map((l) => l.reason),
        trust: (r.trust || {}).trustLevel || null });
    })()`);
    const got = JSON.parse(raw);
    withLimits += got.limits > 0 ? 1 : 0;
    // (1) the chip COUNTS them — the glance level never rounds a limit away,
    //     and an answer with no limit gets no chip rather than a chip saying 0.
    assert.deepEqual(got.chips, got.limits ? [`${got.limits} limits`] : [], `${tool}: the limits chip`);
    // (2) ...and the trust level is outside every fold, chip or no chip.
    assert.ok(got.before.includes(got.trust), `${tool}: the trust level must be visible at rest`);
    // (3) one activation, and every reason the engine wrote is in the document,
    //     word for word — a fold shortens what is SHOWN, never what is said.
    for (const reason of got.reasons) {
      assert.equal(got.before.includes(reason), false, `${tool}: a reason was printed before anyone asked`);
      assert.ok(got.after.includes(reason), `${tool}: this reason never reached the page:\n${reason}`);
    }
  }
  assert.ok(withLimits >= 2, `expected these answers to carry limits, ${withLimits} did`);
});

test('the rail keeps every truncation OUTSIDE the folds, with its own shown/total', async (t) => {
  const { ctx } = await bootPage(t);
  const raw = await ev(ctx, `(async () => {
    const r = await api('overview', {});
    const rail = honesty(r, 'probe-trunc');
    return JSON.stringify({ text: rail.textContent,
      cut: ((r.truncated || {}).fields || []).filter((f) => f.nextOffset != null)
        .map((f) => f.field + ' ' + f.shown + '/' + f.total) });
  })()`);
  const got = JSON.parse(raw);
  for (const chip of got.cut) assert.ok(got.text.includes(chip), `the rail hid a truncation: ${chip}`);
});

test('every hint lead is one line: at most 90 characters, in BOTH catalogues', () => {
  const leads = Object.keys(VIEWER_STRINGS_EN).filter((k) => /^hint\..*\.lead$/.test(k));
  assert.ok(leads.length >= 8, `expected a lead per tab hint, found ${leads.length}`);
  for (const k of leads) {
    assert.ok(VIEWER_STRINGS_EN[k].length <= 90, `${k} (en) is ${VIEWER_STRINGS_EN[k].length} characters`);
    assert.ok(KO_CATALOG[k] && KO_CATALOG[k].length <= 90, `${k} (ko) is ${(KO_CATALOG[k] || '').length} characters`);
    // ...and each one has a `more` to open, or the paragraph was deleted, not folded.
    assert.ok(typeof VIEWER_STRINGS_EN[k.replace(/\.lead$/, '.more')] === 'string', `${k} has no .more`);
  }
});

test('a fold is never auto-opened, remembers itself in localStorage, and survives a language switch', async (t) => {
  const { ctx, byId, store, calls } = await bootPage(t);
  const hint = byId.get('ghintmap');
  const lead = () => hint.querySelector('button');
  const KEY = 'cascade.viewer.fold.hint.graph.map';

  // At rest: closed, and nothing written — the page has made no choice for anyone.
  assert.equal(store.has(KEY), false, 'a fold nobody touched stores nothing');
  assert.equal(lead().getAttribute('aria-expanded'), 'false');
  assert.equal(lead().getAttribute('aria-label'), VIEWER_STRINGS_EN['fold.show']);
  assert.equal(hint.textContent.includes(VIEWER_STRINGS_EN['hint.graph.map.lead']), true);

  lead().onclick();
  assert.equal(store.get(KEY), '1');
  assert.equal(lead().getAttribute('aria-expanded'), 'true');
  assert.equal(lead().getAttribute('aria-label'), VIEWER_STRINGS_EN['fold.hide']);
  const opened = hint.textContent;

  // A language switch REBUILDS this block out of the catalogue. The reader's
  // choice is not part of the catalogue, so it has to come back on its own.
  calls.length = 0;
  byId.get('langseg').children[1].onclick();   // -> ko
  await settle(ctx, 6);
  assert.deepEqual(calls, [], `the switch asked the server for: ${calls.map((c) => c.url).join(', ')}`);
  assert.equal(lead().getAttribute('aria-expanded'), 'true', 'the fold closed itself on a language switch');
  assert.match(hint.textContent, /[가-힣]/);
  assert.notEqual(hint.textContent, opened);
  assert.equal(lead().getAttribute('aria-label'), KO_CATALOG['fold.hide']);

  // Closing is remembered the same way...
  lead().onclick();
  assert.equal(store.get(KEY), '0');
  assert.equal(lead().getAttribute('aria-expanded'), 'false');

  // ...and a page that boots with the memory honours it, without opening
  // anything the reader did not open.
  const again = await bootPage(t, { storage: { [KEY]: '1' } });
  const leads = again.body.querySelectorAll('button.foldlead');
  const open = leads.filter((b) => b.getAttribute('aria-expanded') === 'true');
  assert.equal(open.length, 1, 'exactly the one fold this reader had left open');
  assert.equal(again.byId.get('ghintmap').querySelector('button').getAttribute('aria-expanded'), 'true');
});

test('the "This pack" card is gone, and every field it printed is still on the Overview screen', async (t) => {
  const { ctx, byId } = await bootPage(t);
  const panels = byId.get('ovpanels').textContent;
  assert.equal(/This pack/.test(panels), false, 'the card is gone');
  assert.equal(ev(ctx, "typeof ovPackPanel"), 'undefined', 'and so is the function that drew it');

  // RM21: the ruled TITLE BLOCK is gone too. Its five facts are the masthead's
  // one mono DATELINE (project, lanes, and the build detail behind them) and
  // the chips beside it (freshness, trust, the limits).
  assert.equal(ev(ctx, "document.getElementById('meta')"), null, 'the title block is gone');
  // THE PARTS, IN ORDER — not the concatenation. The dateline's separators are
  // `aria-hidden` middle dots, so gluing the values into one string tested the
  // punctuation as much as the order, and the string changed shape the day the
  // stub started keeping text nodes.
  assert.match(byId.get('projsel').value, /^alpha$/, 'the dateline begins with which pack answered');
  assert.equal(byId.get('mlanes').textContent, 'sql');
  assert.match(byId.get('mdigest').textContent, /^\w/);
  assert.ok(byId.get('mbase'), 'the base-commit field is there even when this pack has no commit for it');
  assert.deepEqual(byId.get('mline').all().filter((n) => n.id && n.id !== 'mline').map((n) => n.id),
    ['projsel', 'projone', 'projnone', 'mlanes', 'mbuildbtn', 'mbuild', 'mdigest', 'mbase'],
    'the dateline reads project, then lanes, then the control that opens the build identity');
  // RM36: the resting freshness verdict is not printed, and the trust level is
  // said in words a first-time reader knows.
  assert.equal(byId.get('mfresh').textContent, '');
  assert.equal(byId.get('mtrust').textContent, 'not certified', 'the trust level is a chip of its own');
  assert.match(byId.get('mtrustchip').title, /UNCERTIFIED/, "...and the engine's own term is one hover away");

  // built: the evidence rail's `basis` block, one activation away.
  const rail = byId.get('ovside');
  const basis = rail.querySelectorAll('button.foldlead').find((b) => b.textContent.trim() === 'basis');
  assert.ok(basis, 'the rail carries a basis block');
  basis.onclick();
  assert.match(rail.textContent, /built/);
  assert.match(rail.textContent, /2026-09-04 00:00:00/, 'the pack’s own build time');
  assert.match(rail.textContent, /freshness/);

  // walked (mode + depth): the ribbon's own note, now one fold below the hero.
  const ribbon = byId.get('ovfold').querySelector('button.foldlead');
  assert.ok(ribbon, 'the ribbon is under a fold, not deleted');
  ribbon.onclick();
  assert.match(byId.get('ovfold').textContent, /mode=conservative, depth 8/);
});

test('a lane row shows its second line for the row being read, and reserves it for the rest', async (t) => {
  const { html } = await startViewer(t);
  const css = styleBlock(html);
  // HIDDEN, not removed: the bezier connectors are measured from the DOM, so a
  // row that changed height under the pointer would move the lines it is on.
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((m) => ({ sel: m[1].replace(/\/\*[\s\S]*?\*\//g, '').trim(), decl: m[2].trim() }));
  const hide = rules.find((r) => r.sel === '.frow .fsub');
  assert.ok(hide, 'no rule hides a lane row second line');
  assert.match(hide.decl, /visibility\s*:\s*hidden/);
  assert.equal(/display\s*:\s*none/.test(hide.decl), false, 'display:none would re-flow the strip on hover');
  const show = rules.find((r) => r.sel.includes('.frow.sel .fsub'));
  assert.ok(show, 'nothing brings the second line back');
  assert.match(show.decl, /visibility\s*:\s*visible/);
  for (const state of [':hover', ':focus', '.sel']) {
    assert.ok(show.sel.includes(`.frow${state} .fsub`), `the second line is not shown for ${state}`);
  }
});

// ---------------------------------------------------------------------------
// TWO THEMES, ONE TOKEN SYSTEM (RM21).
//
// `signal` — the dark instrument panel — is the default; `drawing` is the light
// engineering drawing this page used to be, kept behind a toggle. What is under
// test is that the two are the SAME SYSTEM: the same token names, filled in
// twice, read by the CSS and by every canvas through one accessor — so a switch
// re-draws the page without a reload and without a request.
// ---------------------------------------------------------------------------

// Every token a theme owes. A name missing from either block is a colour some
// rule or some canvas would read as the empty string.
const TOKENS = [
  '--g0', '--g1', '--g2', '--g3', '--hair', '--frame',
  '--t1', '--t2', '--t3',
  '--k-group', '--k-endpoint', '--k-service', '--k-statement', '--k-table', '--k-column',
  '--read', '--write', '--join',
  '--ok', '--warn', '--bad',
  '--glow', '--panel-bg', '--panel-shadow',
  '--r-panel', '--r-chip',
];
const KIND_TOKENS = ['--k-group', '--k-endpoint', '--k-service', '--k-statement', '--k-table', '--k-column'];

test('both themes declare EVERY token — a missing one is a colour read as nothing', async (t) => {
  const { html } = await startViewer(t);
  const signal = themeTokens(html, 'signal');
  const drawing = themeTokens(html, 'drawing');
  for (const [name, tok] of [['signal', signal], ['drawing', drawing]]) {
    const missing = TOKENS.filter((k) => !Object.hasOwn(tok, k));
    assert.deepEqual(missing, [], `[data-theme="${name}"] is missing: ${missing.join(', ')}`);
    for (const k of TOKENS) assert.ok(String(tok[k]).length > 0, `${name} ${k} is empty`);
  }
  // …and the two really are different themes, not one written twice.
  assert.notEqual(signal['--g0'], drawing['--g0']);
  assert.equal(drawing['--glow'], 'none', 'the drawing theme has no glow');
  assert.notEqual(signal['--glow'], 'none', 'the signal theme does');
  // In `drawing` the kind is carried by the GLYPH, so every kind token is the
  // same ink and the page still reads in greyscale. In `signal` they differ.
  assert.equal(new Set(KIND_TOKENS.map((k) => drawing[k])).size, 1,
    'the drawing theme must keep every kind the same ink');
  assert.equal(new Set(KIND_TOKENS.map((k) => signal[k])).size, KIND_TOKENS.length,
    'the signal theme gives every kind its own hue');
  // The default is what the markup ships, and it is the signal room.
  assert.match(html, /<html lang="en" data-theme="signal">/);
});

test('the contrast of every text pair, in both themes, by the WCAG formula', async (t) => {
  const { html } = await startViewer(t);
  const rows = [];
  for (const theme of ['signal', 'drawing']) {
    const tok = themeTokens(html, theme);
    const pairs = [['--t1', '--g0'], ['--t2', '--g1'], ...KIND_TOKENS.map((k) => [k, '--g1'])];
    for (const [fg, bg] of pairs) {
      const ratio = contrast(tok[fg], tok[bg]);
      rows.push(`${theme} ${fg} on ${bg}: ${ratio.toFixed(2)}:1`);
      assert.ok(ratio >= 4.5, `${theme}: ${fg} (${tok[fg]}) on ${bg} (${tok[bg]}) is ${ratio.toFixed(2)}:1`);
    }
  }
  console.log(rows.join('\n'));
});

test('the theme toggle sets data-theme, persists, re-renders the chips — and asks for nothing', async (t) => {
  const { ctx, byId, calls, store, sandbox } = await bootPage(t);
  const seg = byId.get('themeseg');
  assert.deepEqual(seg.children.map((b) => b.textContent), ['Dark', 'Light']);
  assert.deepEqual(seg.children.map((b) => b.className), ['on', ''], 'the signal room is the default');
  assert.equal(sandbox.document.documentElement.getAttribute('data-theme'), 'signal');
  assert.equal(store.get('cascade.viewer.theme'), 'signal');

  // Emptied on purpose: if the switch really re-renders the masthead, the chips
  // it writes come back on their own. The freshness chip is checked through its
  // TOOLTIP, because on this pack the verdict is the resting one and the chip
  // deliberately prints no word for that.
  byId.get('mtrust').textContent = '';
  byId.get('mfreshchip').title = '';
  calls.length = 0;
  seg.children[1].onclick();

  assert.equal(sandbox.document.documentElement.getAttribute('data-theme'), 'drawing');
  assert.equal(store.get('cascade.viewer.theme'), 'drawing');
  assert.deepEqual(calls, [], `the theme switch asked the server for: ${calls.map((c) => c.url).join(', ')}`);
  assert.match(byId.get('mtrust').textContent, /^\w/, 'the trust chip was re-rendered');
  assert.match(byId.get('mfreshchip').title, /freshness unknown/, 'and so was the freshness chip');
  assert.deepEqual(byId.get('themeseg').children.map((b) => b.className), ['', 'on']);
  assert.equal(ev(ctx, 'themeNow()'), 'drawing');

  // …and back, with nothing asked for either way.
  byId.get('themeseg').children[0].onclick();
  assert.equal(sandbox.document.documentElement.getAttribute('data-theme'), 'signal');
  assert.deepEqual(calls, []);
});

test('a theme remembered from last time is the one the page boots in', async (t) => {
  const { sandbox, byId } = await bootPage(t, { storage: { 'cascade.viewer.theme': 'drawing' } });
  assert.equal(sandbox.document.documentElement.getAttribute('data-theme'), 'drawing');
  assert.deepEqual(byId.get('themeseg').children.map((b) => b.className), ['', 'on']);
});

test('the canvases read their colours through the accessor: a theme change moves every one', async (t) => {
  const { ctx, html } = await bootPage(t);
  const signal = themeTokens(html, 'signal');
  const drawing = themeTokens(html, 'drawing');

  const read = () => JSON.parse(ev(ctx, `JSON.stringify({
    table: cssVar('--k-table'), ground: cssVar('--g1'), write: cssVar('--write'),
    kindTable: kindColor('table'), kindEndpoint: kindColor('endpoint'),
    erdInk: erdInk(), erdLine: erdLine(),
    glow: cssVar('--glow'), glows: themeGlows(),
  })`));

  const before = read();
  assert.equal(before.table, signal['--k-table']);
  assert.equal(before.kindTable, signal['--k-table'], 'a node colour IS the kind token');
  assert.equal(before.erdInk, signal['--k-table']);
  assert.equal(before.erdLine, signal['--join']);
  assert.equal(before.glows, true);
  assert.notEqual(before.kindTable, before.kindEndpoint, 'the signal theme separates the kinds');

  ev(ctx, "setTheme('drawing')");
  const after = read();
  assert.equal(after.table, drawing['--k-table'], 'the memo was dropped on the switch');
  assert.equal(after.ground, drawing['--g1']);
  assert.equal(after.write, drawing['--write']);
  assert.equal(after.erdInk, drawing['--k-table']);
  assert.equal(after.erdLine, drawing['--join']);
  assert.equal(after.glows, false, 'the drawing theme has no glow to give a canvas');
  assert.equal(after.kindTable, after.kindEndpoint, 'the drawing theme draws every kind in ink');
  for (const k of ['table', 'ground', 'write', 'kindTable', 'erdInk', 'erdLine']) {
    assert.notEqual(after[k], before[k], `${k} did not follow the theme`);
  }
});

// ---------------------------------------------------------------------------
// The Overview hero (RM21): four KPI dials over the numbers the ribbon had
// ---------------------------------------------------------------------------

test('the KPI dials are drawn from the ribbon\'s own inputs, field for field', async (t) => {
  const { ctx, byId } = await bootPage(t);
  // A dial reads the WHOLE answer now, not `reach` alone: the fifth one is the
  // screens block, and only the dials this answer HAS are drawn.
  const got = JSON.parse(ev(ctx, `(() => {
    const a = OV.resp.answer;
    const rc = a.reach || {};
    return JSON.stringify({ rc, screens: a.screens || null,
      pairs: OV_KPI.filter((k) => k.has(a)).map((k) => [k.got(a), k.of(a)]) });
  })()`));
  const rc = got.rc;
  // The four lanes the ribbon walks, computed here from the raw answer — the
  // page may not have a second opinion about what "reached" means.
  assert.equal(got.screens, null, 'this fixture has no frontend, so there is no fifth dial');
  assert.deepEqual(got.pairs, [
    [(rc.endpoints || 0) - (rc.endpointsWithoutStatement || 0), rc.endpoints || 0],
    [rc.statementsReached || 0, rc.statements || 0],
    [rc.tablesReached || 0, rc.tables || 0],
    [rc.columnsReached || 0, rc.columns || 0],
  ]);

  // …and the cards on the page print exactly those fractions.
  const dens = byId.get('ovcards').querySelectorAll('.kpiden').map((x) => x.textContent);
  assert.equal(dens.length, 4, 'one dial per lane');
  got.pairs.forEach(([reached, total], i) => {
    assert.ok(dens[i].startsWith(`${reached} / ${total}`), `dial ${i}: ${dens[i]}`);
  });

  // The RIBBON is not deleted: it is one fold below the hero, drawn from the
  // same numbers, and it says so when opened.
  const lead = byId.get('ovfold').querySelector('button.foldlead');
  assert.ok(lead, 'the ribbon fold is there');
  assert.equal(lead.getAttribute('aria-expanded'), 'false', 'and it is closed at rest');
  lead.onclick();
  const ribbon = byId.get('ovfold').textContent;
  for (const [reached, total] of got.pairs) {
    assert.ok(ribbon.includes(String(reached)) && ribbon.includes(String(total)),
      `the ribbon lost ${reached}/${total}`);
  }
});

test('the masthead carries the five facts the title block used to rule into a box', async (t) => {
  const { byId } = await bootPage(t);
  // (1) project — the first field of the dateline, and the control when there
  //     is a choice; (2) lanes. (3) digest and (4) base commit are the BUILD
  //     identity, and since RM36 they wait inside the detail the `build`
  //     control opens instead of standing on the always-on line.
  const line = byId.get('mline');
  assert.equal(byId.get('projsel').closest('#mline') != null, true, 'project');
  assert.equal(byId.get('projsel').value, 'alpha');
  assert.equal(byId.get('mlanes').closest('#mline') != null, true, 'lanes');
  assert.equal(byId.get('mlanes').textContent, 'sql');
  assert.equal(byId.get('mdigest').closest('#mbuild') != null, true, 'digest');
  assert.match(byId.get('mdigest').textContent, /^\w/);
  assert.equal(byId.get('mbase').closest('#mbuild') != null, true, 'base commit');
  assert.equal(line.querySelectorAll('.msep').length, 3, 'four fields, three dots');
  // Closed at rest, and ONE click puts the old line back — with the reader's
  // choice remembered, like every other fold on this page.
  assert.equal(byId.get('mbuild').classList.contains('hidden'), true, 'closed at rest');
  assert.equal(byId.get('mbuildbtn').getAttribute('aria-expanded'), 'false');
  byId.get('mbuildbtn').onclick();
  assert.equal(byId.get('mbuild').classList.contains('hidden'), false, 'one click opens it');
  assert.equal(byId.get('mbuildbtn').getAttribute('aria-expanded'), 'true');
  byId.get('mbuildbtn').onclick();
  assert.equal(byId.get('mbuild').classList.contains('hidden'), true, 'and one more closes it');

  // (5) freshness — a chip. Beside it the trust level and the limits, which the
  //     evidence rail also carries: one source, said once at the top. Neither
  //     chip labels itself any more IN INK: it prints the STATE, in plain words,
  //     and the engine's own verdict is in the tooltip. What it labels is the
  //     clipped span a screen reader gets, which has no row of chips to read
  //     the state in context.
  assert.equal(byId.get('mfresh').closest('#mchips') != null, true, 'freshness');
  assert.equal(byId.get('mfresh').textContent, '');
  assert.match(byId.get('mfreshchip').title, /freshness unknown/);
  assert.equal(byId.get('mtrust').textContent, 'not certified', 'trust');
  assert.match(byId.get('mtrustchip').title, /trust UNCERTIFIED/);
  const inked = [byId.get('mfresh'), byId.get('mtrust')].map((n) => n.textContent).join(' ');
  assert.equal(/freshness|trust/.test(inked), false,
    'the chips print the state, not the name of the thing they measure');
  // The language and theme segments live here now too.
  assert.equal(byId.get('langseg').closest('#mchips') != null, true);
  assert.equal(byId.get('themeseg').closest('#mchips') != null, true);

  // The middle dot is allowed on the dateline and NOWHERE else on the page.
  // Asserted on the element that HOLDS the dot, not on every ancestor whose
  // textContent happens to contain one: the header and the body both contain
  // the dateline's punctuation once text nodes are kept.
  const ownText = (n) => n.childNodes.filter((k) => !(k instanceof El)).map((k) => k.text).join('');
  const dots = byId.get('proj').parentNode.parentNode.all()
    .filter((n) => ownText(n).includes('·') && n.closest('#mline') == null);
  assert.deepEqual(dots.map((n) => n.tagName), [], 'a middle dot escaped the dateline');
});

// ---------------------------------------------------------------------------
// RM36: the answer leads, and how much to trust it is one quiet layer behind
// ---------------------------------------------------------------------------

test('the freshness chip speaks only when it has a warning, and the verdict is always in the tooltip', async (t) => {
  const { ctx, byId } = await bootPage(t);

  // `unknown` is the resting state of a pack with no git base to compare
  // against. It is not a failure, and it is the FIRST word a cold reader used
  // to meet, so the chip prints nothing at all for it.
  assert.equal(ev(ctx, "(STATE.meta.freshness && STATE.meta.freshness.verdict) || 'unknown'"), 'unknown');
  assert.equal(byId.get('mfresh').textContent, '');
  assert.equal(byId.get('mfreshchip').className.includes('warn'), false, 'and it is not tinted either');
  assert.match(byId.get('mfreshchip').title, /freshness unknown/, "the engine's verdict, verbatim");
  assert.match(byId.get('mfreshchip').title, /basis\.freshness\.verdict/, '...beside the field it came from');

  // `behind` is the one a reader can act on, so it gets a sentence and the
  // amber. The engine's word is still the tooltip's, never the chip's.
  ev(ctx, "STATE.meta.freshness = { verdict: 'behind' }; renderMastChrome();");
  assert.equal(byId.get('mfresh').textContent, 'older than the code you have now');
  assert.equal(byId.get('mfresh').textContent.includes('behind'), false, 'the verdict word is not the label');
  assert.equal(byId.get('mfreshchip').className.includes('warn'), true);
  assert.match(byId.get('mfreshchip').title, /freshness behind/);

  // An overlay is the other one. `current` is quiet and positive.
  ev(ctx, "STATE.meta.freshness = { verdict: 'provisional-overlay' }; renderMastChrome();");
  assert.equal(byId.get('mfresh').textContent, 'edits folded in on top of this build');
  assert.match(byId.get('mfreshchip').title, /freshness provisional-overlay/);
  ev(ctx, "STATE.meta.freshness = { verdict: 'current' }; renderMastChrome();");
  assert.equal(byId.get('mfresh').textContent, 'up to date');
  assert.equal(byId.get('mfreshchip').className.includes('warn'), false);
  assert.match(byId.get('mfreshchip').title, /freshness current/);

  // A verdict this page has no sentence for is not invented and not swallowed:
  // the chip says nothing and the tooltip still names it.
  ev(ctx, "STATE.meta.freshness = { verdict: 'something-new' }; renderMastChrome();");
  assert.equal(byId.get('mfresh').textContent, '');
  assert.match(byId.get('mfreshchip').title, /freshness something-new/);
});

test('the state a dot stands for is also written for a screen reader, clipped to a pixel', async (t) => {
  const { ctx, byId, html } = await bootPage(t);

  // A coloured dot and a `title` are a pointer's affordances. The same state is
  // in the document as text, so a reader who is being read to gets it without
  // hovering anything — and it names what it is about, because in speech there
  // is no row of chips to read it in context.
  assert.equal(byId.get('mfreshsr').classList.contains('sronly'), true);
  assert.equal(byId.get('mtrustsr').classList.contains('sronly'), true);
  assert.equal(byId.get('mfreshsr').closest('#mfreshchip') != null, true);
  assert.equal(byId.get('mtrustsr').closest('#mtrustchip') != null, true);
  assert.equal(byId.get('mfreshsr').textContent, 'freshness unknown',
    'the resting verdict is silent in ink and spoken here');
  assert.equal(byId.get('mtrustsr').textContent, 'trust not certified');

  // It moves with the state, and it is never left saying the last one.
  ev(ctx, "STATE.meta.freshness = { verdict: 'behind' }; renderMastChrome();");
  assert.equal(byId.get('mfreshsr').textContent, 'freshness older than the code you have now');
  ev(ctx, "STATE.meta.freshness = { verdict: 'current' }; renderMastChrome();");
  assert.equal(byId.get('mfreshsr').textContent, 'freshness up to date');
  ev(ctx, "OV.resp.trust.trustLevel = 'SOMETHING_NEW'; renderMastChrome();");
  assert.equal(byId.get('mtrustsr').textContent, 'trust SOMETHING_NEW',
    'a level with no wording is spoken as it arrived');

  // It costs the layout nothing: taken out of flow, clipped to a pixel, no
  // border and no padding. A rule that ever grew a size would be a visual change
  // nobody asked for.
  const css = styleBlock(html);
  const rule = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((m) => ({ sel: m[1].replace(/\/\*[\s\S]*?\*\//g, '').trim(), decl: m[2].replace(/\s+/g, ' ').trim() }))
    .find((r) => r.sel === '.sronly');
  assert.ok(rule, 'no .sronly rule in the stylesheet');
  for (const want of ['position:absolute', 'width:1px', 'height:1px', 'overflow:hidden', 'border:0']) {
    assert.ok(rule.decl.replace(/\s*:\s*/g, ':').includes(want), `.sronly is missing ${want}: ${rule.decl}`);
  }
  assert.match(rule.decl, /clip-path:\s*inset\(50%\)/);
});

test('the trust chip is quiet and plain, and the engine\'s own level is one hover behind it', async (t) => {
  const { ctx, byId } = await bootPage(t);
  assert.equal(ev(ctx, 'OV.resp.trust.trustLevel'), 'UNCERTIFIED', 'this pack has no golden set');

  // De-shouted, not renamed: the pill says what UNCERTIFIED MEANS, and the
  // tooltip carries the engine's own term verbatim beside the contract field.
  assert.equal(byId.get('mtrust').textContent, 'not certified');
  assert.match(byId.get('mtrustchip').title, /trust UNCERTIFIED/);
  assert.match(byId.get('mtrustchip').title, /no approved golden set/);
  assert.match(byId.get('mtrustchip').title, /trust\.trustLevel/);

  // NEITHER the error red nor the passing green. An uncertified pack is not a
  // broken one, and it is not a certified one either.
  const cls = () => byId.get('mtrustchip').className.split(/\s+/);
  assert.equal(cls().includes('bad'), false, 'an uncertified pack is never painted as an error');
  assert.equal(cls().includes('ok'), false, 'and never as a passing build');

  // With nothing held back it is plain. This is the line that changed: the same
  // state used to take the `ok` tint and read like a certified pack.
  ev(ctx, 'OV.resp.trust.gatesNotShown = []; OV.resp.trust.knownGaps = []; renderMastChrome();');
  assert.deepEqual(cls(), ['mchip', 'quiet']);
  assert.equal(byId.get('mtrust').textContent, 'not certified');

  // A gate it could not show, or a gap it knows about, is the soft amber — read
  // off the engine's own REASONS, never off the level's name. Still not red.
  ev(ctx, "OV.resp.trust.knownGaps = ['the sql lane was read without the java one']; renderMastChrome();");
  assert.equal(cls().includes('warn'), true, 'a held gap is disclosed');
  assert.equal(cls().includes('bad'), false, 'a known blind spot is still not an error');
  assert.match(byId.get('mtrustchip').title, /the sql lane was read without the java one/);
  assert.equal(byId.get('mtrust').textContent, 'not certified', 'and the level itself has not moved');

  // A level with no plain wording here is printed exactly as it arrived: the
  // page never renames a value it does not recognise.
  ev(ctx, "OV.resp.trust.trustLevel = 'SOMETHING_NEW'; OV.resp.trust.knownGaps = []; renderMastChrome();");
  assert.equal(byId.get('mtrust').textContent, 'SOMETHING_NEW');
});

test('a blind spot has a plain name, keeps the engine\'s kind on its tooltip, and is never red', async (t) => {
  const { ctx, byId } = await bootPage(t);
  const kinds = JSON.parse(ev(ctx, 'JSON.stringify(OV.resp.answer.gaps.map((g)=>g.kind))'));
  assert.ok(kinds.length > 0, 'this fixture is expected to disclose blind spots');

  const chips = byId.get('ovherocol').querySelectorAll('button.foldlead.ovchip');
  assert.equal(chips.length, kinds.length, 'one chip per gap the answer carries');
  for (const c of chips) {
    assert.equal(c.classList.contains('bad'), false, `a blind spot is painted as an error: ${c.textContent}`);
  }
  // The engine's own kind stays on every chip's tooltip beside the count, so
  // the plain label never becomes the only name a reader can quote.
  for (const [i, c] of chips.entries()) {
    assert.ok(c.title.includes(kinds[i]), `${kinds[i]} lost its kind: ${c.title}`);
  }

  // Every kind this pack discloses reads in the reader's words, and none of
  // them still shows the slug. Every kind the engine can emit has a label now,
  // so there is nothing on this panel left to fall back.
  for (const k of kinds) {
    const key = `ov.gap.${k}.label`;
    assert.ok(Object.hasOwn(VIEWER_STRINGS.en, key), `${k} has no plain label`);
    const want = VIEWER_STRINGS.en[key];
    const chip = chips[kinds.indexOf(k)];
    assert.ok(chip.textContent.includes(want), `${k} did not read as "${want}": ${chip.textContent}`);
    assert.equal(chip.textContent.includes(k.replace(/-/g, ' ')), false, `${k} still shows its slug`);
  }

  // The fallback is still there for the kind nobody has written yet: it reads
  // as its own slug rather than throwing or printing a catalogue key.
  assert.equal(ev(ctx, "ovGapLabel('a-kind-nobody-has-written-yet')"), 'a kind nobody has written yet');
  assert.equal(ev(ctx, "ovGapLabel('mode-floor')"), VIEWER_STRINGS.en['ov.gap.mode-floor.label']);
  assert.equal(ev(ctx, 'JSON.stringify([...I18N.t.missing])'), '[]',
    'the fallback is by design, so it never files a key in the missing-key ledger');
});

test('the masthead limits chip is the SAME fold as the evidence rail\'s', async (t) => {
  const { ctx, byId, store } = await bootPage(t);
  const chip = byId.get('mlimitcell').querySelector('button.foldlead');
  const limits = JSON.parse(ev(ctx, 'JSON.stringify((OV.resp.limits||[]).map((l)=>l.reason))'));
  assert.ok(limits.length > 0, 'this fixture is expected to carry limits');
  assert.ok(chip, 'the masthead counts them');
  assert.match(chip.textContent, new RegExp(`${limits.length} limits`));
  assert.equal(byId.get('mfolds').textContent.includes(limits[0]), false, 'closed, it says nothing');

  chip.onclick();
  // One activation: every reason the engine wrote is in the document.
  for (const reason of limits) {
    assert.ok(byId.get('mfolds').textContent.includes(reason), `this reason never reached the page: ${reason}`);
  }
  // …and it is the rail's own key, so the rail below agrees about what is open.
  assert.equal(store.get('cascade.viewer.fold.rail.overview.limits'), '1');
  const railChip = byId.get('ovside').querySelectorAll('button.railchip')
    .find((b) => /limits/.test(b.textContent));
  assert.ok(railChip, 'the rail carries the same chip');
  assert.equal(railChip.getAttribute('aria-expanded'), 'true', 'and it opened with it');
});

test('the grade legend moved out of the masthead and into the evidence rail', async (t) => {
  const { ctx, byId } = await bootPage(t);
  assert.equal(ev(ctx, "document.getElementById('legend')"), null, 'no legend row above every tab');
  const head = byId.get('ovside').querySelector('.railhead');
  assert.ok(head, 'the rail has a header');
  for (const g of ['EXACT', 'SOUND_SET', 'HEURISTIC', 'RUNTIME_ONLY', 'UNRESOLVED']) {
    assert.ok(head.textContent.includes(g), `the legend lost ${g}`);
  }
});

test('the Overview and the Graph tab share ONE map answer and ONE renderer', async (t) => {
  const { ctx, byId, calls } = await bootPage(t);
  assert.equal(ev(ctx, 'GMAP.where'), 'overview', 'the cartography IS the map, mounted on the Overview');
  // The renderer itself is a vendored browser bundle no vm has, so the page
  // never gets as far as fetching the answer here; the answer is asked for by
  // hand, and what is under test is that MOVING TABS does not ask again.
  await ev(ctx, "(async () => { GMAP.resp = await api('map', {}); })()");
  await settle(ctx, 4);
  calls.length = 0;

  byId.get('proj').parentNode.parentNode.querySelectorAll('.tab')
    .find((b) => b.dataset.tab === 'graph').onclick();
  await settle(ctx, 6);

  assert.equal(ev(ctx, 'GMAP.where'), 'graph', 'the picture moved to the Graph tab');
  assert.equal(ev(ctx, 'GMAP.resp !== null'), true, 'with the answer it already had');
  assert.deepEqual(calls.filter((c) => c.body && c.body.name === 'map'), [],
    'switching tabs must not fetch the map again');

  // …and back, still one answer and still one mount.
  byId.get('proj').parentNode.parentNode.querySelectorAll('.tab')
    .find((b) => b.dataset.tab === 'overview').onclick();
  await settle(ctx, 6);
  assert.equal(ev(ctx, 'GMAP.where'), 'overview');
  assert.deepEqual(calls.filter((c) => c.body && c.body.name === 'map'), []);
  assert.equal(byId.get('gmapwrap').children.length, 0,
    'the pane the picture left is emptied — no renderer, and no label plane, behind a hidden tab');
  assert.ok(byId.get('ovmapwrap').children.length > 0, 'and the pane it moved to holds it');
});

// ---------------------------------------------------------------------------
// THE MARK. One drawing, four places: the page's inline <symbol>, the favicon
// data URI, the file the viewer serves, and the copy the docs render. They must
// carry the SAME geometry and the SAME palette — a mark that drifts between the
// tab icon and the README is two marks.
// ---------------------------------------------------------------------------

// The fall: three steps that THIN (2.8 -> 2.2 -> 1.6) and LIGHTEN in one hue
// family (ink -> read blue -> its tint), landing on a blue dot. The write red
// and the join ochre are the page's other two saturated colours and are NOT
// the mark's to borrow: a mark tinted `write` would read as a claim.
const MARK_GEOMETRY = ['M2.5 4.5h8v6', 'M10.5 10.5h5.5v6', 'M16 16.5h3.5'];
const MARK_WIDTHS = ['2.8', '2.2', '1.6'];
const MARK_LIGHT = ['#1B2A41', '#2B5FA5', '#7FA6D8'];
const MARK_LIGHT_DOT = '#2B5FA5';
const MARK_DARK = ['#F3F5F8', '#7FA6D8', '#BFD3EC'];
const MARK_DARK_DOT = '#7FA6D8';
const NOT_THE_MARK_S = ['#B33A3A', '#A8842B'];   // write red, join ochre
const readEngine = (...p) => fs.readFileSync(path.join(ENGINE_ROOT, ...p), 'utf8');

/** The three strokes and the dot of one mark drawing, in document order. */
function markParts(svgText) {
  const body = parseBody(`<body>${svgText.replace(/<\?xml[^>]*\?>/, '')}</body>`);
  const paths = body.querySelectorAll('path');
  const dots = body.querySelectorAll('circle');
  assert.equal(paths.length, 3, 'a mark is three strokes');
  assert.equal(dots.length, 1, 'a mark lands on exactly one dot');
  return {
    d: paths.map((p) => p.getAttribute('d')),
    widths: paths.map((p) => p.getAttribute('stroke-width')),
    strokes: paths.map((p) => p.getAttribute('stroke')),
    dot: dots[0].getAttribute('fill'),
    dotAt: [dots[0].getAttribute('cx'), dots[0].getAttribute('cy'), dots[0].getAttribute('r')],
  };
}

test("the page's inline symbol is the mark: thinning strokes, one hue family, a blue dot", () => {
  const html = readEngine('viewer', 'index.html');
  const body = parseBody(html);
  const sym = body.querySelector('#cascade-mark');
  assert.ok(sym, 'the page carries the mark once, as a <symbol>');
  assert.equal(sym.tagName, 'SYMBOL');
  assert.equal(sym.getAttribute('viewBox'), '0 0 24 24');
  const parts = markParts(html.slice(html.indexOf('<symbol id="cascade-mark"'), html.indexOf('</symbol>')));
  assert.deepEqual(parts.d, MARK_GEOMETRY);
  assert.deepEqual(parts.widths, MARK_WIDTHS);
  assert.deepEqual(parts.strokes, MARK_LIGHT, 'ink, then read blue, then its tint');
  assert.equal(parts.dot, MARK_LIGHT_DOT);
  assert.deepEqual(parts.dotAt, ['20.5', '16.5', '1.9']);

  // Every use of it points at that one symbol, and the symbol names its own
  // colours: it cannot be re-tinted by whatever it happens to sit inside.
  const uses = body.querySelectorAll('use');
  assert.ok(uses.length >= 1);
  for (const u of uses) assert.equal(u.getAttribute('href'), '#cascade-mark');
  const markup = html.slice(html.indexOf('<symbol id="cascade-mark"'), html.indexOf('</symbol>'));
  assert.equal(/currentColor/.test(markup), false, 'the mark states its colours; it does not inherit them');
  assert.equal(/[Gg]radient/.test(markup), false, 'never a gradient');
  for (const hue of NOT_THE_MARK_S) assert.equal(markup.includes(hue), false, `${hue} is not the mark's colour`);
});

test('the favicon is that same drawing, inline, with the same palette', () => {
  const html = readEngine('viewer', 'index.html');
  const m = html.match(/<link rel="icon" type="image\/svg\+xml" href="([^"]+)"/);
  assert.ok(m, 'the page declares an SVG favicon');
  assert.ok(m[1].startsWith('data:image/svg+xml,'), 'inline, so it costs no request');
  const svg = decodeURIComponent(m[1].slice('data:image/svg+xml,'.length)).replace(/'/g, '"');
  const parts = markParts(svg);
  assert.deepEqual(parts.d, MARK_GEOMETRY);
  assert.deepEqual(parts.widths, MARK_WIDTHS);
  assert.deepEqual(parts.strokes, MARK_LIGHT);
  assert.equal(parts.dot, MARK_LIGHT_DOT);
});

test('the shipped files: the light mark and its dark-ground variant, geometry for geometry', () => {
  for (const dir of [['viewer'], ['docs', 'assets']]) {
    const light = markParts(readEngine(...dir, 'cascade-mark.svg'));
    assert.deepEqual(light.d, MARK_GEOMETRY, `${dir.join('/')} light: geometry`);
    assert.deepEqual(light.widths, MARK_WIDTHS, `${dir.join('/')} light: widths`);
    assert.deepEqual(light.strokes, MARK_LIGHT, `${dir.join('/')} light: palette`);
    assert.equal(light.dot, MARK_LIGHT_DOT);

    const dark = markParts(readEngine(...dir, 'cascade-mark-dark.svg'));
    assert.deepEqual(dark.d, MARK_GEOMETRY, `${dir.join('/')} dark: the SAME geometry`);
    assert.deepEqual(dark.widths, MARK_WIDTHS, `${dir.join('/')} dark: widths`);
    assert.deepEqual(dark.strokes, MARK_DARK, `${dir.join('/')} dark: palette`);
    assert.equal(dark.dot, MARK_DARK_DOT);
  }
  // The served copy and the rendered-in-docs copy are the same bytes: one
  // drawing, kept in two places only because they are read by different things.
  for (const name of ['cascade-mark.svg', 'cascade-mark-dark.svg']) {
    assert.equal(readEngine('viewer', name), readEngine('docs', 'assets', name), `${name} drifted between viewer/ and docs/assets/`);
  }
});

test('README and the docs index show the mark, and hand a dark browser the dark one', () => {
  for (const [doc, base] of [['README.md', 'docs/assets/'], [path.join('docs', 'index.md'), 'assets/']]) {
    const lines = readEngine(doc).split('\n');
    const at = lines.findIndex((l) => l.startsWith('# '));
    assert.ok(at >= 0, `${doc}: has no title line`);
    // Only the language switcher may stand above the title, and it is one line
    // of text. Anything else there is a banner, which is what this asserts
    // against: the mark belongs BESIDE the name, at reading size, not as a
    // letterhead the reader has to scroll past.
    const above = lines.slice(0, at).filter((l) => l.trim().length > 0);
    assert.ok(above.length <= 1 && above.every((l) => /\]\(README(\.ko)?\.md\)|\*\*(English|한국어)\*\*/.test(l)),
      `${doc}: the mark sits beside the title, not above it as a banner (found: ${above.join(' / ')})`);
    const first = lines[at];
    assert.ok(first.includes(`<img src="${base}cascade-mark.svg" width="28" alt="">`), `${doc}: the light mark, 28px, decorative`);
    assert.ok(first.includes(`<source media="(prefers-color-scheme: dark)" srcset="${base}cascade-mark-dark.svg">`), `${doc}: a dark browser gets the dark variant`);
    // The paths are RELATIVE: nothing here reaches for a host.
    for (const src of first.match(/(?:src|srcset)="([^"]+)"/g) || []) {
      const rel = src.slice(src.indexOf('"') + 1, -1);
      assert.equal(/^[a-z]+:|^\/\//.test(rel), false, `${doc}: ${rel} is not a relative path`);
      assert.ok(fs.existsSync(path.join(ENGINE_ROOT, path.dirname(doc), rel)), `${doc}: ${rel} does not resolve`);
    }
  }
});

// ---------------------------------------------------------------------------
// RM22 — the map at rest is groups and tables; endpoints unfold on demand.
//
// The fixture pack here is SQL-only (no routes, so no groups and no endpoints),
// so the aggregation is tested against a HAND-WRITTEN answer of the exact shape
// `map` returns. That is the point: what is under test is the page's rendering
// of an answer, not the engine's answer.
// ---------------------------------------------------------------------------

/** Two groups, three endpoints, two tables — the smallest map with a fold in it. */
const MAP_ANSWER = {
  nodes: [
    { id: 'group:g1', kind: 'group', label: 'g1', degree: 0, endpoints: 2 },
    { id: 'group:g2', kind: 'group', label: 'g2', degree: 0, endpoints: 1 },
    { id: 'endpoint:GET /g1/a', kind: 'endpoint', label: 'GET /g1/a', degree: 0, group: 'g1' },
    { id: 'endpoint:GET /g1/b', kind: 'endpoint', label: 'GET /g1/b', degree: 0, group: 'g1' },
    { id: 'endpoint:GET /g2/c', kind: 'endpoint', label: 'GET /g2/c', degree: 0, group: 'g2' },
    { id: 'table:t1', kind: 'table', label: 't1', degree: 0, comment: null, columnCount: 4 },
    { id: 'table:t2', kind: 'table', label: 't2', degree: 0, comment: null, columnCount: 2 },
  ],
  links: [
    { source: 'group:g1', target: 'endpoint:GET /g1/a', kind: 'member', grade: 'EXACT' },
    { source: 'group:g1', target: 'endpoint:GET /g1/b', kind: 'member', grade: 'EXACT' },
    { source: 'group:g2', target: 'endpoint:GET /g2/c', kind: 'member', grade: 'EXACT' },
    { source: 'endpoint:GET /g1/a', target: 'table:t1', kind: 'touches', access: 'read', statements: 2, grade: 'EXACT' },
    { source: 'endpoint:GET /g1/b', target: 'table:t1', kind: 'touches', access: 'write', statements: 1, grade: 'EXACT' },
    { source: 'endpoint:GET /g1/b', target: 'table:t2', kind: 'touches', access: 'read', statements: 1, grade: 'SOUND_SET' },
    { source: 'endpoint:GET /g2/c', target: 'table:t1', kind: 'touches', access: 'read', statements: 3, grade: 'EXACT' },
    { source: 'table:t1', target: 'table:t2', kind: 'joins', grade: 'EXACT', witness: 2 },
  ],
  summary: {
    groups: 2, endpoints: 3, tables: 2, tablesTouched: 2, links: 8, linksTotal: 8, nodesTotal: 7,
    shown: { groups: 2, endpoints: 3, tables: 2, statements: 0 },
    cutBy: null, bytes: null, maxBytes: null, walk: { mode: 'conservative', depth: 8 },
  },
};

/** Put that answer in the page and build the picture's model from it. */
async function withMap(t) {
  const boot = await bootPage(t, { hash: '#p=alpha&tab=graph' });
  ev(boot.ctx, `GMAP.resp = { answer: ${JSON.stringify(MAP_ANSWER)}, limits: [] };
    GMAP.where='graph'; GMAP.pos=new Map(); GMAP.open=new Set(); GMAP.hidden=new Set(); GMAP.sel=null;
    buildMapModel();`);
  return boot;
}
const model = (ctx) => JSON.parse(ev(ctx, `JSON.stringify({
  nodes: GMAP.nodes.map((n)=>({id:n.id, kind:n.kind, degree:n.degree, r:n.r, val:n.val})),
  links: GMAP.links.map((l)=>({kind:l.data.kind, s:l.sid, t:l.tid, w:l.w, faded:!!l.faded,
    endpoints:l.data.endpoints ?? null, reads:l.data.reads ?? null, writes:l.data.writes ?? null,
    access:l.data.access ?? null, statements:l.data.statements ?? null})),
})`));

test('the map at rest holds no endpoint: each group aggregates its own', async (t) => {
  const { ctx } = await withMap(t);
  const m = model(ctx);
  assert.deepEqual(m.nodes.map((n) => n.id).sort(),
    ['group:g1', 'group:g2', 'table:t1', 'table:t2'], 'groups and tables, nothing else');
  assert.equal(m.nodes.some((n) => n.kind === 'endpoint'), false);

  const agg = m.links.filter((l) => l.kind === 'aggregate');
  assert.equal(agg.length, 3, 'one line per (group, table) that any endpoint under it touches');
  assert.equal(m.links.filter((l) => l.kind === 'joins').length, 1, 'joins stay');
  assert.equal(m.links.length, 4, 'and nothing else is drawn at rest');

  const g1t1 = agg.find((l) => l.s === 'group:g1' && l.t === 'table:t1');
  assert.equal(g1t1.endpoints, 2, 'two of g1\'s endpoints touch t1');
  assert.equal(g1t1.reads + g1t1.writes, g1t1.endpoints, 'the split accounts for every touch');
  assert.deepEqual([g1t1.reads, g1t1.writes], [1, 1]);
  assert.equal(g1t1.access, 'write', 'a tie goes to the write — the strongest thing on the line');
  assert.equal(g1t1.statements, 3, 'and the statements behind the two touches are summed');

  const g1t2 = agg.find((l) => l.s === 'group:g1' && l.t === 'table:t2');
  assert.deepEqual([g1t2.endpoints, g1t2.reads, g1t2.writes, g1t2.access], [1, 1, 0, 'read']);
  const g2t1 = agg.find((l) => l.s === 'group:g2' && l.t === 'table:t1');
  assert.deepEqual([g2t1.endpoints, g2t1.reads, g2t1.writes, g2t1.access], [1, 1, 0, 'read']);

  // Every aggregate's endpoint count adds up to the touches the answer carries.
  const touches = MAP_ANSWER.links.filter((l) => l.kind === 'touches').length;
  assert.equal(agg.reduce((n, l) => n + l.endpoints, 0), touches);
});

test('unfolding a group adds exactly its endpoints and their links; folding takes them back', async (t) => {
  const { ctx } = await withMap(t);
  const rest = model(ctx);

  ev(ctx, "mapToggleGroup('group:g1', true); buildMapModel();");
  const open = model(ctx);
  assert.deepEqual(
    open.nodes.map((n) => n.id).filter((id) => !rest.nodes.some((n) => n.id === id)).sort(),
    ['endpoint:GET /g1/a', 'endpoint:GET /g1/b'], 'exactly g1\'s endpoints appeared');
  assert.equal(open.nodes.length, rest.nodes.length + 2);
  // Their own lines: two member links and the three touches they carry.
  const added = open.links.length - rest.links.length;
  assert.equal(added, 5, 'two member links and the three touches those endpoints make');
  assert.equal(open.links.filter((l) => l.kind === 'member').length, 2);
  assert.equal(open.links.filter((l) => l.kind === 'touches').length, 3);
  assert.equal(open.links.filter((l) => l.kind === 'aggregate').length, 3,
    'the aggregates are NOT deleted — the two readings must be able to agree');
  const faded = open.links.filter((l) => l.kind === 'aggregate' && l.faded);
  assert.deepEqual(faded.map((l) => l.t).sort(), ['table:t1', 'table:t2'],
    'only the open group\'s aggregates step back');

  ev(ctx, "mapToggleGroup('group:g1', false); buildMapModel();");
  const back = model(ctx);
  assert.deepEqual(back, rest, 'folding restores the resting picture exactly');
});

test('a folded group is sized by its endpoints, an unfolded one by its tables', async (t) => {
  const { ctx } = await withMap(t);
  const rest = model(ctx);
  const t1 = rest.nodes.find((n) => n.id === 'table:t1');
  assert.equal(rest.nodes.find((n) => n.id === 'group:g1').degree, 2, 'two endpoints stand inside it');
  assert.equal(t1.degree, 2, 'two groups touch t1');
  assert.equal(rest.nodes.find((n) => n.id === 'table:t2').degree, 1);

  ev(ctx, "mapToggleGroup('group:g1', true); buildMapModel();");
  const open = model(ctx);
  assert.equal(open.nodes.find((n) => n.id === 'group:g1').degree, 2, 'unfolded: the tables it reaches');
  assert.equal(open.nodes.find((n) => n.id === 'endpoint:GET /g1/b').degree, 2, 'an endpoint: tables reached');
  assert.equal(open.nodes.find((n) => n.id === 'table:t1').degree, 3,
    'g2 still folded, and both of g1\'s endpoints now touch t1 in their own right');
});

test('the size model: sqrt of degree, monotone, clamped at both ends, and the hit disc follows it', async (t) => {
  const { ctx } = await withMap(t);
  const r = (d) => Number(ev(ctx, `mapRadius(${d})`));
  const MIN = Number(ev(ctx, 'GMAP_R_MIN')), MAX = Number(ev(ctx, 'GMAP_R_MAX'));
  assert.equal(r(0), MIN, 'a node with nothing on it is still a node');
  assert.equal(r(-5), MIN, 'and a nonsense degree cannot make it smaller');
  assert.equal(r(100000), MAX, 'nothing may swallow its own neighbourhood');
  let prev = -Infinity;
  for (let d = 0; d <= 200; d++) {
    const v = r(d);
    assert.ok(v >= prev, `radius fell between ${d - 1} and ${d}`);
    assert.ok(v >= MIN && v <= MAX, `radius out of band at ${d}: ${v}`);
    prev = v;
  }
  assert.ok(r(4) - r(1) > r(100) - r(97), 'sqrt: the first connections count for more than the hundredth');
  // The library paints sqrt(nodeVal) x nodeRelSize, and nodeRelSize is 1 here,
  // so val MUST be r squared or the hit disc is not the drawn disc.
  for (const n of model(ctx).nodes) assert.ok(Math.abs(n.val - n.r * n.r) < 1e-9, `${n.id}: val is not r squared`);
});

test('the label rule: every group, the top of the range by radius, the lit neighbourhood, and a deep zoom', async (t) => {
  const { ctx } = await withMap(t);
  ev(ctx, `GMAP.nodes = [
    {id:'group:g', kind:'group', r:3.0}, {id:'a', kind:'table', r:4}, {id:'b', kind:'table', r:5},
    {id:'c', kind:'table', r:6}, {id:'d', kind:'table', r:7}, {id:'e', kind:'table', r:18},
    {id:'sat', kind:'endpoint', r:18}];
    GMAP.labelR = mapLabelFloor(GMAP.nodes);
    GMAP.restLabels = new Set(GMAP.nodes.filter(mapRestLabel).map(n=>n.id));
    GMAP.lit = null;`);
  // Six radii, [3,4,5,6,7,18]: the 60th percentile sits on the fourth of them.
  assert.equal(Number(ev(ctx, 'GMAP.labelR')), 6);
  assert.deepEqual(JSON.parse(ev(ctx, 'JSON.stringify([...GMAP.restLabels])')), ['group:g', 'c', 'd', 'e'],
    'every group, plus the nodes at or above the 60th percentile');

  const wants = (id, k) => ev(ctx, `mapWantsLabel(GMAP.nodes.find(n=>n.id===${JSON.stringify(id)}), ${k})`);
  assert.equal(wants('b', 1), false, 'a small node is anonymous at rest');
  assert.equal(wants('a', 1), false);
  assert.equal(wants('a', Number(ev(ctx, 'GMAP_LABEL_ZOOM'))), true, 'zoomed in, every NAMEABLE node in view is named');
  assert.equal(wants('group:g', 1), true, 'a group is named however small it is');

  ev(ctx, "GMAP.lit={id:'e', nodes:new Set(['e','a']), links:new Set()}; GMAP.litLabels=new Set(['e','a']);");
  assert.equal(wants('a', 1), true, 'the lit node and its neighbours are always named');
  assert.equal(wants('d', 1), false, 'and nothing else is, however big');
  assert.equal(wants('d', 4), false, 'a spotlight outranks the zoom');

  // A satellite is anonymous until it is LIT, however big it is and however far
  // the picture is zoomed in: an open group puts two dozen route strings inside
  // the space its own name needs, and the group's name is what stands for the
  // cluster until the reader picks one out of it (RM25).
  ev(ctx, 'GMAP.lit=null;');
  assert.equal(ev(ctx, "GMAP.restLabels.has('sat')"), false);
  assert.equal(wants('sat', 1), false, 'an endpoint carries no name at rest');
  assert.equal(wants('sat', Number(ev(ctx, 'GMAP_LABEL_ZOOM'))), false, 'and none when the picture is zoomed in either');
  assert.equal(wants('sat', 8), false, 'however far in');
  ev(ctx, "GMAP.lit={id:'sat', nodes:new Set(['sat']), links:new Set()}; GMAP.litLabels=new Set(['sat']);");
  assert.equal(wants('sat', 1), true, 'and a lit one always does');
  ev(ctx, 'GMAP.lit=null;');

  // Size follows the radius, in the band the picture promises.
  const size = (r) => Number(ev(ctx, `mapLabelSize({r:${r}})`));
  assert.equal(size(Number(ev(ctx, 'GMAP_R_MIN'))), Number(ev(ctx, 'GMAP_LABEL_MIN')));
  assert.equal(size(Number(ev(ctx, 'GMAP_R_MAX'))), Number(ev(ctx, 'GMAP_LABEL_MAX')));
  assert.ok(size(10) > size(6) && size(6) > size(4));
});

test('the links are quiet at rest, loud where the reader is looking — and the theme sets how quiet', async (t) => {
  const { ctx } = await withMap(t);
  const alpha = (s) => { const m = /rgba\([^,]+,[^,]+,[^,]+,([\d.]+)\)/.exec(s); return m ? Number(m[1]) : 1; };
  const of = (i) => alpha(ev(ctx, `mapLinkColor(GMAP.links[${i}])`));
  assert.equal(of(0), 0.18, 'the signal theme: 0.18');
  ev(ctx, "setTheme('drawing')");
  assert.equal(of(0), 0.28, 'the drawing theme: the same ink over paper needs more');
  ev(ctx, "setTheme('signal')");

  ev(ctx, 'GMAP.lit={id:GMAP.links[0].sid, nodes:new Set(), links:new Set([0])};');
  assert.equal(of(0), 1, 'the lit chain draws at full strength');
  assert.equal(of(1), 0.12, 'and everything else drops away without leaving. At 0.06 it left.');
  const w = JSON.parse(ev(ctx, 'JSON.stringify(GMAP.links.map(l=>l.w))'));
  for (const x of w) assert.ok(x >= 0.6 && x <= 3, `link width ${x} is outside 0.6-3`);
  assert.equal(Number(ev(ctx, 'mapLinkW(GMAP.links[0])')), w[0] + 1, 'the lit line gains a pixel');
});

test('the count line says what the picture folded away, and the control names the state', async (t) => {
  const { ctx, byId } = await withMap(t);
  ev(ctx, 'renderMapCounts(); renderMapFoldNote();');
  const line = () => byId.get('gcounts').textContent.replace(/\s+/g, ' ').trim();
  assert.match(line(), /2 groups/);
  assert.match(line(), /3 endpoints folded/);
  const seg = () => byId.get('gfold').children.filter((b) => b.classList.contains('on')).map((b) => b.dataset.fold);
  assert.deepEqual(seg(), ['folded']);

  ev(ctx, 'mapUnfoldAll(); buildMapModel(); renderMapCounts(); renderMapFoldNote();');
  assert.match(line(), /3 endpoints in 2 open group\(s\), 0 still folded/);
  assert.deepEqual(seg(), ['endpoints']);

  ev(ctx, 'mapFoldAll(); buildMapModel(); renderMapCounts(); renderMapFoldNote();');
  assert.match(line(), /3 endpoints folded/);
  assert.deepEqual(seg(), ['folded']);
});

test('Find on a folded endpoint unfolds its group instead of answering "it is in there somewhere"', async (t) => {
  const { ctx } = await withMap(t);
  assert.equal(ev(ctx, "GMAP.byId.has('endpoint:GET /g1/a')"), false, 'folded away to start with');
  assert.equal(ev(ctx, "GMAP.answerById.has('endpoint:GET /g1/a')"), true, 'but the answer still has it');
  ev(ctx, "mapReveal('endpoint:GET /g1/a')");
  assert.equal(ev(ctx, "GMAP.open.has('group:g1')"), true, 'its group was opened');
  assert.equal(ev(ctx, "GMAP.byId.has('endpoint:GET /g1/a')"), true, 'and it is on the map');
  assert.equal(ev(ctx, 'GMAP.sel'), 'endpoint:GET /g1/a', 'and lit');
});

// ---------------------------------------------------------------------------
// RM22 — the ERD by the same rules
// ---------------------------------------------------------------------------

test('the ERD radius is sqrt of the relationship degree, in its own band', async (t) => {
  const { ctx } = await bootPage(t);
  const r = (d) => Number(ev(ctx, `erdRadius(${d})`));
  const MIN = Number(ev(ctx, 'ERD_R_MIN')), MAX = Number(ev(ctx, 'ERD_R_MAX'));
  assert.equal(r(0), MIN);
  assert.equal(r(10000), MAX);
  let prev = -Infinity;
  for (let d = 0; d <= 200; d++) { const v = r(d); assert.ok(v >= prev && v >= MIN && v <= MAX); prev = v; }
  assert.ok(r(4) - r(1) > r(100) - r(97), 'sqrt, so the first joins count for more');
  const size = (rr) => Number(ev(ctx, `erdLabelSize(${rr})`));
  assert.equal(size(MIN), Number(ev(ctx, 'ERD_LABEL_MIN')));
  assert.equal(size(MAX), Number(ev(ctx, 'ERD_LABEL_MAX')));
  assert.ok(size(12) > size(6), 'a hub is labelled larger');
});

test('the ERD name-prefix tint exists in the signal theme only — the drawing stays ink', async (t) => {
  const { ctx } = await bootPage(t);
  const fams = "[{family:'pms',count:18},{family:'ums',count:12},{family:'sms',count:9},{family:'cms',count:5},{family:'oms',count:3},{family:'xms',count:2},{family:null,count:4}]";
  const colours = (theme) => {
    ev(ctx, `setTheme('${theme}')`);
    return JSON.parse(ev(ctx, `(()=>{ const f=erdFamilyColor(${fams});
      return JSON.stringify(['pms_a','ums_a','sms_a','cms_a','oms_a','xms_a','plain'].map(f)); })()`));
  };
  const signal = colours('signal');
  assert.equal(new Set(signal.slice(0, 5)).size, 5, 'the five biggest families each get their own tint');
  assert.equal(signal[5], signal[6], 'the sixth family and the prefix-less tables stay ink');
  const ink = ev(ctx, 'erdInk()');
  assert.equal(signal[6], ink);
  for (const c of signal.slice(0, 5)) {
    assert.match(c, /^#[0-9a-f]{6}$/i);
    assert.notEqual(c, ink);
  }
  const drawing = colours('drawing');
  const drawInk = ev(ctx, 'erdInk()');
  for (const c of drawing) assert.equal(c, drawInk, 'a draughtsman does not colour a plan by filename');
  ev(ctx, "setTheme('signal')");
});

test('the ERD tints are DESATURATED kin of the kind palette, not new colours', async (t) => {
  const { ctx, html } = await bootPage(t);
  const tok = themeTokens(html, 'signal');
  const tints = JSON.parse(ev(ctx, 'JSON.stringify(erdTints())'));
  assert.equal(tints.length, 5);
  const chan = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const spread = (hex) => { const c = chan(hex); return Math.max(...c) - Math.min(...c); };
  const kinds = ['--k-table', '--k-endpoint', '--k-group', '--k-statement', '--k-column'];
  tints.forEach((tint, i) => {
    assert.ok(spread(tint) < spread(tok[kinds[i]]), `${kinds[i]} was not desaturated`);
  });
});

// ---------------------------------------------------------------------------
// RM22 — direction on the Flow and Impact lanes
// ---------------------------------------------------------------------------

async function withLanes(t, storage) {
  const boot = await bootPage(t, { hash: '#p=alpha&tab=impact', storage });
  await ev(boot.ctx, `(async () => {
    const r = await api('flow', { column: 'alpha_order.total', direction: 'up', depth: 8 });
    IMPACTV.resp = r; IMPACTV.sel = null;
    renderChain(IMPACTV, r);
  })()`);
  await settle(boot.ctx, 8);
  return boot;
}
const laneSvg = (byId) => byId.get('impactwrap').querySelectorAll('svg').at(0);

test('every visible connector carries 1-3 dots, riding its own path in the call direction', async (t) => {
  const { ctx, byId } = await withLanes(t);
  const svg = laneSvg(byId);
  const paths = svg.querySelectorAll('path').filter((p) => p.className === 'flink');
  assert.ok(paths.length > 0, 'the walk drew connectors to decorate');
  const groups = svg.querySelectorAll('g').filter((g) => g.className === 'fdots');
  assert.equal(groups.length, paths.length, 'one dot group per connector');

  const ids = paths.map((p) => p.getAttribute('id'));
  assert.equal(new Set(ids).size, ids.length, 'each connector has an id of its own for the <mpath>');
  for (const id of ids) assert.match(id, /^fp-impact-\d+$/, 'scoped to the view, so Flow and Impact never collide');

  for (const g of groups) {
    assert.ok(g.kids.length >= 1 && g.kids.length <= 3, `a connector carries ${g.kids.length} dots`);
    for (const c of g.kids) {
      assert.equal(c.tagName, 'CIRCLE');
      assert.equal(String(c.getAttribute('r')), '2.2');
      const anim = c.kids[0];
      assert.equal(anim.tagName, 'ANIMATEMOTION');
      assert.equal(anim.getAttribute('repeatCount'), 'indefinite');
      assert.equal(anim.getAttribute('keyPoints'), '1;0', 'Impact runs its dots the way the CALL goes');
      const mpath = anim.kids[0];
      assert.equal(mpath.tagName, 'MPATH');
      assert.ok(ids.includes(mpath.getAttribute('href').slice(1)), 'and it rides a path that exists');
    }
  }
  // The count is a function of the length, in one place, and it is a function.
  const n = (len) => Number(ev(ctx, `laneDotCount(${len})`));
  assert.deepEqual([n(0), n(60), n(200), n(400), n(4000)], [1, 1, 1, 2, 3]);
  // ...and the length itself is measured off the curve, not off the DOM.
  assert.equal(Math.round(Number(ev(ctx, 'laneCurveLength(0,0,0,0,100,0,100,0)'))), 100);
});

test('a reader who asked for less motion gets an arrowhead, and not one animation', async (t) => {
  const { ctx, byId } = await withLanes(t);
  ev(ctx, "globalThis.matchMedia = () => ({ matches: true }); drawChainLinks(IMPACTV);");
  const svg = laneSvg(byId);
  const paths = svg.querySelectorAll('path');
  const links = paths.filter((p) => p.className === 'flink');
  const arrows = paths.filter((p) => p.className === 'farrow');
  assert.ok(links.length > 0);
  assert.equal(arrows.length, links.length, 'one static arrowhead per connector instead');
  assert.equal(svg.querySelectorAll('animateMotion').length, 0, 'and nothing moves');
  assert.equal(svg.querySelectorAll('g').filter((g) => g.className === 'fdots').length, 0);
  ev(ctx, 'delete globalThis.matchMedia; drawChainLinks(IMPACTV);');
  assert.ok(laneSvg(byId).querySelectorAll('animateMotion').length > 0, 'and it comes back when they change their mind');
});

test('Flow on/off is ONE preference: one key, the map and both lane views', async (t) => {
  const { ctx, byId, store } = await withLanes(t);
  const KEY = ev(ctx, 'FLOW_KEY');
  assert.equal(KEY, 'cascade.viewer.flow');
  assert.ok(laneSvg(byId).querySelectorAll('animateMotion').length > 0, 'the dots are running to start with');

  ev(ctx, 'flowToggle()');
  assert.equal(ev(ctx, 'GMAP.flow'), false);
  assert.equal(store.get(KEY), 'off', 'the one key holds it');
  assert.equal(laneSvg(byId).querySelectorAll('animateMotion').length, 0, 'the lanes stopped');
  assert.equal(Number(ev(ctx, 'mapParticles({i:0, data:{kind:"touches", statements:2}})')), 0,
    'and so did the map');
  for (const id of ['gflow', 'fflow', 'iflow']) {
    assert.equal(byId.get(id).textContent, 'Flow off', `${id} says so too`);
    assert.equal(byId.get(id).getAttribute('aria-pressed'), 'false');
  }

  ev(ctx, 'flowToggle()');
  assert.equal(store.get(KEY), 'on');
  assert.ok(laneSvg(byId).querySelectorAll('animateMotion').length > 0);
});

test('the flow preference remembered from last time is the one the page boots in', async (t) => {
  const { ctx, byId } = await withLanes(t, { 'cascade.viewer.flow': 'off' });
  assert.equal(ev(ctx, 'GMAP.flow'), false);
  assert.equal(byId.get('gflow').textContent, 'Flow off');
  assert.equal(laneSvg(byId).querySelectorAll('animateMotion').length, 0);
});

test('the chain being read owns the motion: its dots brighten, the rest come off', async (t) => {
  const { ctx, byId } = await withLanes(t);
  const groups = () => laneSvg(byId).querySelectorAll('g').filter((g) => /\bfdots\b/.test(g.className));
  assert.equal(groups().filter((g) => g.classList.contains('hot')).length, 0, 'nothing is hot at rest');
  const key = ev(ctx, 'JSON.stringify(IMPACTV.paths[0].to)');
  ev(ctx, `flowHover(IMPACTV, ${key})`);
  const hot = groups().filter((g) => g.classList.contains('hot'));
  assert.ok(hot.length > 0, 'the chain through that row is lit');
  assert.equal(hot.length + groups().filter((g) => g.classList.contains('off')).length, groups().length,
    'every connector is one or the other');

  // A row nothing joins: the whole picture stops, and none of it is hot.
  ev(ctx, "flowHover(IMPACTV, 'nothing:at:all')");
  assert.equal(groups().filter((g) => g.classList.contains('hot')).length, 0);
  assert.equal(groups().filter((g) => g.classList.contains('off')).length, groups().length,
    'the connectors outside the chain being read stop');

  ev(ctx, 'flowClearHover(IMPACTV)');
  assert.equal(groups().filter((g) => g.classList.contains('hot')).length, 0);
  assert.equal(groups().filter((g) => g.classList.contains('off')).length, 0, 'and they all run again');
});

test('the resting map does not move: the toggle has to say so, but a lit chain flows anyway', async (t) => {
  const { ctx, byId } = await withMap(t);
  const dots = (i) => Number(ev(ctx, `mapParticles(GMAP.links[${i}])`));
  const note = () => byId.get('gflownote').textContent;

  // Untouched. The signal theme's own default is "on" — the LANES take that,
  // because there the dots sit on a handful of connectors and are the point —
  // but 111 aggregate lines all speckled is the clutter this round removed.
  assert.equal(ev(ctx, 'GMAP.flow'), true, 'the shared preference is on in the signal theme');
  assert.equal(ev(ctx, 'GMAP.flowTouched'), false);
  assert.equal(ev(ctx, 'mapFlowsAtRest()'), false, 'but the map does not animate on a default');
  assert.equal(dots(0), 0);
  ev(ctx, 'renderMapFlowNote()');
  assert.match(note(), /still at rest/, 'and the toolbar says so');
  assert.match(byId.get('gflownote').title, /speckle/, 'with the reason one hover away');

  // Light a node: its own chain flows, everything else stays still.
  ev(ctx, 'mapSetLit(GMAP.links[0].sid);');
  assert.ok(dots(0) > 0, "the lit node's own lines flow");
  const off = ev(ctx, 'GMAP.links.findIndex((l)=>!GMAP.lit.links.has(l.i))');
  assert.ok(off >= 0);
  assert.equal(dots(off), 0, 'and no other line does');

  // …even with the toggle explicitly OFF.
  ev(ctx, 'flowToggle()');
  assert.equal(ev(ctx, 'GMAP.flow'), false);
  assert.ok(dots(0) > 0, 'a lit chain is the thing being answered — it flows regardless');
  ev(ctx, 'mapSetLit(null);');
  assert.equal(dots(0), 0, 'and with nothing lit and the toggle off, nothing moves');

  // Flow on means every link, as before.
  ev(ctx, 'flowToggle()');
  assert.equal(ev(ctx, 'GMAP.flow'), true);
  assert.equal(ev(ctx, 'mapFlowsAtRest()'), true, 'now it has been asked for');
  assert.ok(dots(0) > 0, 'and every line carries the direction');
  ev(ctx, 'renderMapFlowNote()');
  assert.equal(note(), '', 'the note is gone: the toggle speaks for itself now');
});

test('less motion means less motion: not even a spotlight animates', async (t) => {
  const { ctx } = await withMap(t);
  ev(ctx, "globalThis.matchMedia = () => ({ matches: true }); GMAP.flow=true; GMAP.flowTouched=true; mapSetLit(GMAP.links[0].sid);");
  assert.equal(Number(ev(ctx, 'mapParticles(GMAP.links[0])')), 0);
  ev(ctx, 'delete globalThis.matchMedia;');
  assert.ok(Number(ev(ctx, 'mapParticles(GMAP.links[0])')) > 0);
});

// ---------------------------------------------------------------------------
// RM25 — the canvas is the page, the layout holds still, and a node is a disc
// ---------------------------------------------------------------------------

test('the Graph pane is measured from its own top offset, and never runs past the window', async (t) => {
  const { ctx } = await withMap(t);
  // The stub's boxes are all the same size, so the ONE thing this measurement
  // depends on is fed in: where the pane starts. Two window sizes, the two the
  // picture is checked at.
  const sizeAt = (vw, vh, top) => Number(ev(ctx, `(()=>{
    const w=byId('gwrap');
    w.getBoundingClientRect=()=>({top:${top}, left:0, right:1027, bottom:${top}, width:1027, height:0});
    window.innerWidth=${vw}; window.innerHeight=${vh};
    return graphPaneResize();
  })()`));

  // 1440x900: the toolbar and the one hint lead line leave the canvas at 218.
  const wide = sizeAt(1440, 900, 218);
  assert.equal(wide, 900 - 218 - 14, 'the pane takes the rest of the window, less a hairline of air');
  assert.ok(218 + wide <= 900, 'and its bottom is inside the window');
  assert.ok(wide >= 420);
  assert.equal(ev(ctx, "byId('gwrap').style.height"), `${wide}px`);
  assert.equal(ev(ctx, "byId('gside').style.maxHeight"), `${wide}px`,
    'the rail beside it gets the same height and keeps its own scroll');

  // 1100x800: at the stylesheet's single-column breakpoint the rail goes UNDER
  // the picture, so the page scrolls anyway and the canvas takes the smaller of
  // 72vh and what is left.
  const narrow = sizeAt(1100, 800, 268);
  assert.equal(narrow, Math.min(Math.round(800 * 0.72), 800 - 268 - 14));
  assert.ok(268 + narrow <= 800);
  assert.ok(narrow >= 420);

  // A window too short for either answer still gets a picture, not a slot.
  assert.equal(sizeAt(1440, 500, 300), 420, 'the floor holds');
});

test('the legend, the chips and the count line are INSIDE the canvas, not stacked above it', () => {
  const html = readEngine('viewer', 'index.html');
  const body = parseBody(html);
  const wrap = body.querySelector('#gwrap');
  assert.ok(wrap, 'the page still has a canvas pane');
  const inside = new Set(wrap.all().map((n) => n.id).filter(Boolean));
  for (const id of ['gchips', 'gmapleg', 'gcounts', 'klegend', 'glineleg']) {
    assert.ok(inside.has(id), `#${id} must sit inside #gwrap, on the picture`);
  }
  // …and nothing of that kind is left standing between the toolbar and the
  // canvas, which is what was eating 180px of a 900px window.
  const tab = body.querySelector('#tab-graph');
  const between = [];
  for (const kid of tab.children) {
    if (kid.id === 'gwrap' || kid.querySelector('#gwrap')) break;
    for (const cls of ['gmapleg', 'chips', 'gcount', 'klegend']) {
      if (kid._classes().has(cls) || kid.querySelectorAll(`.${cls}`).length) between.push(`${kid.tagName}.${cls}`);
    }
  }
  assert.deepEqual(between, [], 'these rows are back above the canvas');
  // The fit button is the one control that puts a wandered picture back.
  assert.ok(body.querySelector('#gfit'), 'the toolbar carries a fit button');
});

test('the position store: a settled layout is pinned, and an unfold moves only what it adds', async (t) => {
  const { ctx } = await withMap(t);
  // Stand the model up where a settle would have left it, then settle it.
  ev(ctx, `GMAP.drawn='2d'; GMAP.layout='full'; GMAP.api=null;
    GMAP.nodes.forEach((n,i)=>{ n.x=100+i*40; n.y=60+i*25; });
    mapSettled();`);
  const pins = JSON.parse(ev(ctx, 'JSON.stringify(GMAP.nodes.map(n=>[n.id, n.fx, n.fy]))'));
  for (const [id, fx, fy] of pins) {
    assert.ok(fx != null && fy != null, `${id} was left free to drift after the settle`);
  }
  const cached = JSON.parse(ev(ctx, "JSON.stringify([...GMAP.pos].map(([k,v])=>[k, v.x, v.y, v.pin]))"));
  assert.equal(cached.length, pins.length);
  for (const [id, , , pin] of cached) assert.equal(pin, true, `${id} was cached without its pin`);

  // UNFOLD: only g1's endpoints appear, and only they are free to move.
  const before = JSON.parse(ev(ctx, 'JSON.stringify(GMAP.nodes.map(n=>[n.id,n.fx,n.fy]))'));
  ev(ctx, "mapToggleGroup('group:g1', true); buildMapModel('2d');");
  const after = new Map(JSON.parse(ev(ctx, 'JSON.stringify(GMAP.nodes.map(n=>[n.id,[n.fx,n.fy]]))')));
  for (const [id, fx, fy] of before) {
    assert.deepEqual(after.get(id), [fx, fy], `${id} moved, and nothing asked it to`);
  }
  const loose = [...after].filter(([, v]) => v[0] == null).map(([k]) => k).sort();
  assert.deepEqual(loose, ['endpoint:GET /g1/a', 'endpoint:GET /g1/b'],
    'exactly the new satellites are free; everything else is nailed down');
  assert.equal(Number(ev(ctx, 'GMAP.loose')), 2);
  assert.equal(Number(ev(ctx, "mapCache('2d').size")), before.length,
    'the cache still holds exactly what settled, and nothing the unfold added');

  // FOLD: they go, and nothing else is touched.
  ev(ctx, "mapToggleGroup('group:g1', false); buildMapModel('2d');");
  const folded = new Map(JSON.parse(ev(ctx, 'JSON.stringify(GMAP.nodes.map(n=>[n.id,[n.fx,n.fy]]))')));
  assert.equal(folded.size, before.length);
  for (const [id, fx, fy] of before) assert.deepEqual(folded.get(id), [fx, fy], `${id} moved on the way back`);
  assert.equal(Number(ev(ctx, 'GMAP.loose')), 0, 'nothing to place means nothing to simulate');
});

test('a theme change repaints the map and reheats nothing', async (t) => {
  const { ctx } = await withMap(t);
  // A recording renderer: every accessor the page can call on it is answered,
  // and the names are kept.
  ev(ctx, `globalThis.RM25={calls:[]};
    GMAP.drawn='2d';
    const rec=(name)=>function(){ RM25.calls.push(name); return GMAP.api; };
    GMAP.api={ nodeColor:rec('nodeColor'), linkColor:rec('linkColor'), linkWidth:rec('linkWidth'),
      linkDirectionalParticles:rec('linkDirectionalParticles'),
      linkDirectionalParticleWidth:rec('linkDirectionalParticleWidth'),
      nodeCanvasObject:rec('nodeCanvasObject'), backgroundColor:rec('backgroundColor'),
      d3ReheatSimulation:rec('d3ReheatSimulation'), graphData:rec('graphData'),
      zoomToFit:rec('zoomToFit'), centerAt:rec('centerAt'), zoom:rec('zoom') };`);
  ev(ctx, "setTheme('drawing')");
  const calls = JSON.parse(ev(ctx, 'JSON.stringify(RM25.calls)'));
  assert.ok(calls.includes('nodeCanvasObject'), 'the canvas is repainted');
  assert.equal(calls.includes('d3ReheatSimulation'), false, 'nothing is laid out again');
  assert.equal(calls.includes('graphData'), false, 'and the model is not handed over again');
  assert.equal(calls.includes('zoomToFit'), false, 'nor is the view refitted under the reader');
  // The fills were re-read out of the new theme's tokens.
  const fill = ev(ctx, "GMAP.nodes.find(n=>n.kind==='table').fill");
  assert.equal(fill, ev(ctx, "cssVar('--n-table')"));
  ev(ctx, "setTheme('signal'); GMAP.api=null; delete globalThis.RM25;");
});

test('a node is a filled disc at rest, and only a lit one is outlined in its own colour', async (t) => {
  const { ctx } = await withMap(t);
  // A recording 2D context. `stroke` is written down WITH the colour it was
  // asked for, because a disc always carries one stroke: a hairline of the
  // canvas ground, so two discs that touch still read as two. That is the
  // ground, not ink. Ink around a disc means "this one is the answer".
  ev(ctx, `globalThis.RM25CTX=()=>{
    const c={ ops:[], strokes:[], _ss:null, _fs:null, canvas:{width:900, height:620},
      save(){}, restore(){}, beginPath(){}, arc(){}, moveTo(){}, lineTo(){}, closePath(){}, rect(){},
      measureText(){ return {width:40}; }, strokeText(){ c.ops.push('strokeText'); }, fillText(){ c.ops.push('fillText'); },
      fill(){ c.ops.push('fill'); }, stroke(){ c.ops.push('stroke'); c.strokes.push(c._ss); },
      setLineDash(){}, };
    Object.defineProperty(c,'strokeStyle',{get(){return c._ss;}, set(v){c._ss=v;}});
    Object.defineProperty(c,'fillStyle',{get(){return c._fs;}, set(v){c._fs=v;}});
    c.lineWidth=1; c.font=''; c.textAlign=''; c.textBaseline=''; c.shadowColor=''; c.shadowBlur=0; c.lineJoin='';
    return c;
  };
  GMAP.nodes.forEach((n,i)=>{ n.x=100+i*60; n.y=80+i*40; });`);

  const draw = (id) => JSON.parse(ev(ctx, `(()=>{
    const c=RM25CTX(); mapFrameReset(c, 1);
    mapDrawNode2D(GMAP.byId.get(${JSON.stringify(id)}), c, 1);
    return JSON.stringify({ops:c.ops, strokes:c.strokes});
  })()`));

  ev(ctx, 'GMAP.lit=null; GMAP.litLabels=new Set();');
  const rest = draw('table:t1');
  assert.ok(rest.ops.includes('fill'), 'at rest a node is FILLED. It used to be a hollow ring that vanished under the lines.');
  const ground = ev(ctx, "cssVar('--g1')");
  assert.deepEqual([...new Set(rest.strokes)], [ground],
    'every stroke at rest is the canvas ground, never the node’s own ink');

  // The spotlight, set by hand so this stays a test of the DRAWING: on this
  // four-node fixture every node is a neighbour of t1, and the point here is
  // what a lit node looks like against one that is not.
  ev(ctx, "GMAP.lit={id:'table:t1', nodes:new Set(['table:t1']), links:new Set()}; GMAP.litLabels=new Set(['table:t1']);");
  const lit = draw('table:t1');
  assert.ok(lit.ops.includes('fill'));
  const own = ev(ctx, "mapNodeFill(GMAP.byId.get('table:t1'))");
  assert.ok(lit.strokes.includes(own), 'the lit node is ringed in its own colour');

  // …and a node the spotlight passed over is dimmed, not deleted.
  const other = ev(ctx, "mapNodeFill(GMAP.byId.get('group:g2'))");
  assert.match(other, /^rgba\(/, 'an unlit node keeps its hue at an alpha');
  assert.equal(other.endsWith(`,${ev(ctx, 'GMAP_NODE_DIM')})`), true, `unlit nodes draw at GMAP_NODE_DIM: ${other}`);
  ev(ctx, 'GMAP.lit=null;');
});

test('the label placer refuses a box that lands on a node disc, and flips left before it drops one', async (t) => {
  const { ctx } = await withMap(t);
  ev(ctx, `globalThis.RM25CTX=()=>{
    const c={ ops:[], strokes:[], _ss:null, _fs:null, canvas:{width:900, height:620},
      save(){}, restore(){}, beginPath(){}, arc(){}, moveTo(){}, lineTo(){}, closePath(){}, rect(){},
      measureText(){ return {width:40}; }, strokeText(){ c.ops.push('strokeText'); }, fillText(){ c.ops.push('fillText'); },
      fill(){ c.ops.push('fill'); }, stroke(){ c.ops.push('stroke'); c.strokes.push(c._ss); },
      setLineDash(){}, };
    Object.defineProperty(c,'strokeStyle',{get(){return c._ss;}, set(v){c._ss=v;}});
    Object.defineProperty(c,'fillStyle',{get(){return c._fs;}, set(v){c._fs=v;}});
    c.lineWidth=1; c.font=''; c.textAlign=''; c.textBaseline=''; c.shadowColor=''; c.shadowBlur=0; c.lineJoin='';
    return c;
  };
  globalThis.RM25BOX=(nx, ny, blockRight, blockLeft)=>{
    const c=RM25CTX();
    // One node to name, and the obstacles the frame has already claimed.
    GMAP.nodes=[{id:'n', kind:'table', label:'name', r:6, x:nx, y:ny}];
    GMAP.byId=new Map([['n',GMAP.nodes[0]]]);
    GMAP.restLabels=new Set(['n']); GMAP.lit=null; GMAP.view=null;
    GMAP.placed=[]; GMAP.discs=0;
    if(blockRight) { GMAP.placed.push({x:nx+6, y:ny-10, w:60, h:20}); GMAP.discs++; }
    if(blockLeft)  { GMAP.placed.push({x:nx-110, y:ny-10, w:100, h:20}); GMAP.discs++; }
    const before=GMAP.placed.length;
    mapDrawLabel2D(GMAP.nodes[0], c, 1);
    return GMAP.placed.length>before ? GMAP.placed[GMAP.placed.length-1] : null;
  };`);
  const box = (r, l) => JSON.parse(ev(ctx, `JSON.stringify(RM25BOX(200, 200, ${r}, ${l}))`));

  const plain = box(false, false);
  assert.ok(plain && plain.x > 200, 'with room on the right, the name stands to the right of its node');

  const flipped = box(true, false);
  assert.ok(flipped && flipped.x < 200, 'blocked on the right, it flips to the left');

  assert.equal(box(true, true), null, 'blocked on both sides it is DROPPED. Two names on one spot read as a third, wrong one.');

  // And the frame really does claim every disc, however small: that rule is
  // what put the names on the nodes when it had a six-pixel floor.
  ev(ctx, `GMAP.nodes=[{id:'a',kind:'table',label:'a',r:3,x:10,y:10},{id:'b',kind:'table',label:'b',r:18,x:400,y:300}];`);
  const claimed = Number(ev(ctx, '(()=>{ const c=RM25CTX(); mapFrameReset(c, 1); return GMAP.discs; })()'));
  assert.equal(claimed, 2, 'a three-pixel dot is an obstacle too');
});

test('the flow button reports what its own picture does, in all three states', async (t) => {
  // unset / on / off. The lane views animate the moment the preference is on;
  // the MAP is still until the toggle has actually been touched, and the note
  // beside the button says so. The two must never disagree.
  for (const [stored, wantPressed] of [[null, 'false'], ['on', 'true'], ['off', 'false']]) {
    const storage = stored ? { 'cascade.viewer.flow': stored } : {};
    const boot = await bootPage(t, { hash: '#p=alpha&tab=graph', storage });
    ev(boot.ctx, `GMAP.resp = { answer: ${JSON.stringify(MAP_ANSWER)}, limits: [] };
      GMAP.where='graph'; buildMapModel('2d'); renderMapFlowNote();`);
    const pressed = boot.byId.get('gflow').getAttribute('aria-pressed');
    const note = boot.byId.get('gflownote').textContent;
    const hidden = boot.byId.get('gflownote').classList.contains('hidden');
    assert.equal(pressed, wantPressed, `stored ${stored}: aria-pressed`);
    const flows = ev(boot.ctx, 'mapFlowsAtRest()');
    assert.equal(pressed, String(flows), `stored ${stored}: pressed must mean "this map animates"`);
    if (!flows) {
      assert.equal(hidden, false, `stored ${stored}: the note must say the map is still`);
      assert.equal(note, VIEWER_STRINGS.en['graph.flow.rest']);
    } else {
      assert.equal(hidden, true, `stored ${stored}: nothing to explain when it really is running`);
    }
    // The two lane buttons answer for THEIR pictures, which do run on the
    // preference alone.
    assert.equal(boot.byId.get('fflow').getAttribute('aria-pressed'), String(ev(boot.ctx, 'GMAP.flow')));
  }
});

test('the rail says what the number beside each table is, and the drill-down gives the search box back', async (t) => {
  const { ctx, byId } = await withMap(t);
  const heading = () => {
    ev(ctx, 'setKids(byId("gside"), mapLeadCard());');
    return byId.get('gside').querySelectorAll('h2').map((h) => h.textContent);
  };
  assert.ok(heading().includes(VIEWER_STRINGS.en['map.lead.tables']),
    'folded, the number is the API groups that reach the table');
  ev(ctx, "mapToggleGroup('group:g1', true);");
  assert.ok(heading().includes(VIEWER_STRINGS.en['map.lead.tables.open']),
    'unfolded, it is the endpoints');
  ev(ctx, "mapToggleGroup('group:g1', false);");

  // One box, two questions: Around's query must not be left in the map's box.
  ev(ctx, "GRAPHV.mode='map'; byId('gfocus').value='pms_';");
  ev(ctx, "openGraph('table:t1');");
  assert.equal(byId.get('gfocus').value, 'table:t1', 'the drill-down asks its own question');
  ev(ctx, "graphMode('map');");
  assert.equal(byId.get('gfocus').value, 'pms_', 'and hands the map its own back');
});

test('a window resize re-measures the pane, even when the masthead re-wraps under it', async (t) => {
  const boot = await withMap(t);
  const { ctx, fireWindow } = boot;
  // The failure this pins, seen in a real Chrome at 1440x900 -> 1728x906: the
  // masthead re-wraps at the new width, so the pane starts LOWER than it did
  // when the height was measured, and the bottom lands past the window. The
  // stub reproduces exactly that: where the box starts is a function of the
  // window's width, so any height computed before the width settled is wrong.
  ev(ctx, `(()=>{
    const w=byId('gwrap');
    globalThis.RM25TOP=()=> window.innerWidth>1600 ? 218 : 214;
    w.getBoundingClientRect=()=>({top:RM25TOP(), left:0, right:1027, bottom:RM25TOP(), width:1027, height:0});
  })()`);
  const paneH = () => Number(String(ev(ctx, "byId('gwrap').style.height")).replace('px', ''));
  const top = () => Number(ev(ctx, 'RM25TOP()'));
  const gap = Number(ev(ctx, 'GMAP_PANE_GAP'));

  ev(ctx, 'window.innerWidth=1440; window.innerHeight=900; graphPaneResize();');
  assert.equal(paneH(), 900 - 214 - gap, 'the starting point: measured against the narrow masthead');

  // The window changes. NOTHING inside the Graph tab changed size, which is
  // why the tab's own ResizeObserver never fired for this.
  ev(ctx, 'window.innerWidth=1728; window.innerHeight=906;');
  fireWindow('resize');
  await new Promise((r) => { setTimeout(r, 500); });

  assert.equal(top(), 218, 'the masthead re-wrapped and the pane starts lower');
  assert.equal(paneH(), 906 - 218 - gap, 'the height is measured against the top it actually has');
  assert.ok(top() + paneH() <= 906, `the pane bottom (${top() + paneH()}) is inside the 906px window`);
  assert.equal(ev(ctx, "byId('gside').style.maxHeight"), `${paneH()}px`, 'and the rail follows it');

  // …and back again, so this is a measurement rather than a one-way ratchet.
  ev(ctx, 'window.innerWidth=1440; window.innerHeight=900;');
  fireWindow('resize');
  await new Promise((r) => { setTimeout(r, 500); });
  assert.equal(paneH(), 900 - 214 - gap);
  assert.ok(top() + paneH() <= 900);

  // A tab that is not on screen has no top to measure, so nothing is written.
  ev(ctx, "byId('tab-graph').classList.add('hidden'); window.innerHeight=1200;");
  fireWindow('resize');
  await new Promise((r) => { setTimeout(r, 500); });
  assert.equal(paneH(), 900 - 214 - gap, 'a hidden tab is not re-measured');
  ev(ctx, "byId('tab-graph').classList.remove('hidden');");
});

test('the measurement checks itself: a top that moves as the height is applied is measured again', async (t) => {
  const { ctx } = await withMap(t);
  // One pass is not enough when writing the height moves the box: the page
  // above it re-wraps, or the scroll clamps. So the top is read again AFTER the
  // height is applied, and a top that moved is measured again.
  ev(ctx, `(()=>{
    const w=byId('gwrap');
    globalThis.RM25READS=0;
    // While the height is released the box reads one place; once it carries a
    // height it reads another. A single-pass measurement takes the first.
    w.getBoundingClientRect=()=>{
      RM25READS++;
      const held=String(w.style.height||'').endsWith('px');
      return {top: held ? 260 : 200, left:0, right:1027, bottom:0, width:1027, height:0};
    };
    window.innerWidth=1440; window.innerHeight=900;
  })()`);
  const h = Number(ev(ctx, 'graphPaneResize()'));
  const gap = Number(ev(ctx, 'GMAP_PANE_GAP'));
  assert.ok(Number(ev(ctx, 'RM25READS')) >= 4, 'it measured, applied, and looked again');
  assert.equal(h, 900 - 200 - gap, 'it settles on the height its own last measurement asked for');
  assert.ok(h >= Number(ev(ctx, 'GMAP_PANE_MIN')));
});

// ---------------------------------------------------------------------------
// RM27: the browse rail. Every tab opens SHOWING the pack, and the page counts
// nothing: the rows, the counts and the chips are one `browse` answer, and the
// filter is a substring test over what is already here.
// ---------------------------------------------------------------------------

/** Fire the listeners a node registered with addEventListener (the stub keeps them). */
function fire(node, evName, extra = {}) {
  for (const fn of node._listeners.get(evName) || []) {
    fn({ type: evName, target: node, preventDefault() {}, stopPropagation() {}, ...extra });
  }
}
/** The tool calls this page has made, newest last. */
const toolCalls = (calls, name) => calls
  .filter((c) => c.url.startsWith('/api/call') && c.body && (!name || c.body.name === name))
  .map((c) => ({ name: c.body.name, args: c.body.arguments }));
const rowsOf = (byId, listId) => byId.get(listId).querySelectorAll('.brrow');

test('each of the three tabs OPENS on the pack: one browse request, rows on screen, nothing to type first', async (t) => {
  const { ctx, byId, calls } = await bootPage(t, { ids: ['gamma'], hash: '#p=gamma&tab=explore' });

  // Explore: the tables, busiest first, from ONE request.
  assert.deepEqual(toolCalls(calls, 'browse'), [{ name: 'browse', args: { kind: 'table', limit: 200, sort: 'statements' } }]);
  assert.deepEqual(rowsOf(byId, 'exlist').map((r) => r.title), ['gamma_order', 'gamma_item', 'gamma_audit']);
  assert.equal(byId.get('excount').textContent, '3 shown of 3');
  // The kind chips carry the pack's own totals, and Methods carries none: it
  // cannot be listed until two letters are typed.
  // Screens is there with its own total: this fixture has no frontend, so the
  // total is 0 and picking it says "not shipped" in the engine's own words.
  assert.deepEqual(byId.get('exkinds').children.map((b) => b.textContent),
    ['Tables3', 'Columns4', 'Statements3', 'Endpoints3', 'Methods', 'Screens0']);

  calls.length = 0;
  ev(ctx, `document.querySelector('.tab[data-tab="flow"]').click()`);
  await settle(ctx, 8);
  assert.deepEqual(toolCalls(calls, 'browse'), [{ name: 'browse', args: { kind: 'endpoint', limit: 200, sort: 'tables' } }]);
  assert.deepEqual(toolCalls(calls, 'flow'), [], 'opening Flow draws no chain: there is nothing to draw yet');
  assert.deepEqual(rowsOf(byId, 'flist').map((r) => r.title),
    ['POST /order/save', 'GET /order/{id}', 'GET /admin/ping']);
  // Flow buckets its rows under the API group the server put on each of them.
  assert.deepEqual(byId.get('flist').querySelectorAll('.brgname').map((g) => g.textContent),
    ['▾ order', '▾ admin']);

  calls.length = 0;
  ev(ctx, `document.querySelector('.tab[data-tab="impact"]').click()`);
  await settle(ctx, 8);
  assert.deepEqual(toolCalls(calls, 'browse'), [{ name: 'browse', args: { kind: 'table', limit: 200, sort: 'endpoints' } }]);
  assert.deepEqual(rowsOf(byId, 'ilist').map((r) => r.title), ['gamma_order', 'gamma_item', 'gamma_audit']);

  // Coming back to a tab that has already answered asks for nothing again.
  calls.length = 0;
  ev(ctx, `document.querySelector('.tab[data-tab="explore"]').click()`);
  await settle(ctx, 6);
  assert.deepEqual(toolCalls(calls), []);
});

test('typing in the filter sends NO request and narrows the rows the page already holds', async (t) => {
  const { ctx, byId, calls } = await bootPage(t, { ids: ['gamma'], hash: '#p=gamma&tab=explore' });
  calls.length = 0;
  const q = byId.get('q');
  // The filter is debounced (RAIL_FILTER_MS), so every step waits past it.
  const typed = async (text) => { q.value = text; fire(q, 'input'); await settle(ctx, 40); };
  await typed('item');
  assert.deepEqual(toolCalls(calls), [], 'the filter is a substring test, not a query');
  assert.deepEqual(rowsOf(byId, 'exlist').map((r) => r.title), ['gamma_item']);
  assert.equal(byId.get('excount').textContent, '1 shown of 3');
  // A comment matches too, and the count line still names the pack's total.
  await typed('ORDERS TABLE');
  assert.deepEqual(rowsOf(byId, 'exlist').map((r) => r.title), ['gamma_order']);
  // Nothing matched is the PAGE's own sentence, and it names what was typed.
  // It must NOT borrow the engine's `not-in-this-axis` wording, which is about
  // the walk having nothing on that side of the chain.
  await typed('zzz');
  assert.deepEqual(rowsOf(byId, 'exlist'), []);
  assert.equal(byId.get('exlist').textContent, 'no row matches zzz');
  assert.equal(/not on this side of the chain/.test(byId.get('exlist').textContent), false);
  assert.deepEqual(toolCalls(calls), [], 'still nothing asked');
});

test('a filter that matches nothing is the PAGE speaking; an empty list is the ENGINE', async (t) => {
  // The same miss, on all three tabs, and the three of them say the same thing.
  const { ctx, byId } = await bootPage(t, { ids: ['gamma'], hash: '#p=gamma&tab=explore' });
  const miss = async (tab, inputId, listId) => {
    ev(ctx, `document.querySelector('.tab[data-tab="${tab}"]').click()`);
    await settle(ctx, 10);
    const box = byId.get(inputId);
    box.value = 'zzz';
    fire(box, 'input');
    await settle(ctx, 40);
    return byId.get(listId).textContent;
  };
  assert.equal(await miss('explore', 'q', 'exlist'), 'no row matches zzz');
  assert.equal(await miss('flow', 'fentry', 'flist'), 'no row matches zzz');
  assert.equal(await miss('impact', 'ientry', 'ilist'), 'no row matches zzz');
  // ...and it is a catalogue key, so it moves with the language.
  byId.get('langseg').children[1].onclick();
  await settle(ctx, 6);
  assert.match(byId.get('ilist').textContent, /[가-힣]/);
  assert.match(byId.get('ilist').textContent, /zzz/, 'the translation still names what was typed');

  // A list that is empty BEFORE anybody types keeps the ENGINE's own reason.
  const noJava = await bootPage(t, { hash: '#p=alpha&tab=flow' });
  await settle(noJava.ctx, 6);
  assert.match(noJava.byId.get('flist').textContent, /not shipped/);
  assert.equal(/no row matches/.test(noJava.byId.get('flist').textContent), false);
});

test('picking a row hands the id to the renderer that answers it, and the row stays marked', async (t) => {
  const explore = await bootPage(t, { ids: ['gamma'], hash: '#p=gamma&tab=explore' });
  explore.calls.length = 0;
  rowsOf(explore.byId, 'exlist')[0].click();
  await settle(explore.ctx, 8);
  assert.deepEqual(toolCalls(explore.calls, 'table_usage'),
    [{ name: 'table_usage', args: { table: 'gamma_order' } }]);
  const marked = rowsOf(explore.byId, 'exlist').filter((r) => r.getAttribute('aria-selected') === 'true');
  assert.deepEqual(marked.map((r) => r.title), ['gamma_order']);
  assert.equal(marked[0].classList.contains('on'), true);

  const flow = await bootPage(t, { ids: ['gamma'], hash: '#p=gamma&tab=flow' });
  flow.calls.length = 0;
  rowsOf(flow.byId, 'flist')[0].click();
  await settle(flow.ctx, 10);
  const drawn = toolCalls(flow.calls, 'flow');
  assert.equal(drawn.length, 1, `Flow drew ${drawn.length} chains`);
  assert.equal(drawn[0].args.endpoint, 'POST /order/save');
  assert.equal(drawn[0].args.direction, undefined, 'walking down is the default');
  assert.equal(flow.byId.get('fentry').value, 'POST /order/save');

  const impact = await bootPage(t, { ids: ['gamma'], hash: '#p=gamma&tab=impact' });
  impact.calls.length = 0;
  rowsOf(impact.byId, 'ilist')[0].click();
  await settle(impact.ctx, 10);
  const up = toolCalls(impact.calls, 'flow');
  assert.equal(up.length, 1, `Impact drew ${up.length} chains`);
  assert.equal(up[0].args.direction, 'up');
  assert.equal(up[0].args.table, 'gamma_order', 'the KIND is carried, never guessed back out of the name');
  assert.deepEqual(toolCalls(impact.calls, 'search'), [], 'a picked row needs no second request to learn its kind');
});

test('the Impact caret opens a table into its own columns, with ONE request, asked once', async (t) => {
  const { ctx, byId, calls } = await bootPage(t, { ids: ['gamma'], hash: '#p=gamma&tab=impact' });
  calls.length = 0;
  const caret = byId.get('ilist').querySelectorAll('.brcaret')[0];
  assert.equal(caret.getAttribute('aria-expanded'), 'false');
  caret.click();
  await settle(ctx, 8);
  assert.deepEqual(toolCalls(calls, 'browse'),
    [{ name: 'browse', args: { kind: 'column', table: 'gamma_order', limit: 200 } }]);
  const kids = byId.get('ilist').querySelectorAll('.brchild');
  assert.deepEqual(kids.map((k) => k.title), ['gamma_order.total', 'gamma_order.id'],
    'the columns of that table, most written first');
  assert.deepEqual(kids.map((k) => k.querySelector('.brid').textContent), ['total', 'id'],
    'a column under its own table does not repeat the table name');

  // Collapse and open again: the answer is kept, so nothing is asked twice.
  calls.length = 0;
  byId.get('ilist').querySelectorAll('.brcaret')[0].click();
  await settle(ctx, 4);
  assert.deepEqual(byId.get('ilist').querySelectorAll('.brchild'), []);
  byId.get('ilist').querySelectorAll('.brcaret')[0].click();
  await settle(ctx, 6);
  assert.deepEqual(toolCalls(calls), []);
  assert.equal(byId.get('ilist').querySelectorAll('.brchild').length, 2);

  // A column picked from the tree walks up from THAT column.
  calls.length = 0;
  byId.get('ilist').querySelectorAll('.brchild')[0].click();
  await settle(ctx, 10);
  const up = toolCalls(calls, 'flow');
  assert.equal(up.length, 1);
  assert.equal(up[0].args.column, 'gamma_order.total');
  assert.equal(up[0].args.direction, 'up');
});

test('a language switch re-draws the whole rail from memory and asks the server for nothing', async (t) => {
  const { ctx, byId, calls } = await bootPage(t, { ids: ['gamma'], hash: '#p=gamma&tab=explore' });
  assert.equal(byId.get('excount').textContent, '3 shown of 3');
  calls.length = 0;
  byId.get('langseg').children[1].onclick();   // -> ko
  await settle(ctx, 6);

  assert.deepEqual(calls, [], `the switch asked the server for: ${calls.map((c) => c.url).join(', ')}`);
  for (const [what, text] of [
    ['the kind chips', byId.get('exkinds').textContent],
    ['the count line', byId.get('excount').textContent],
    ['the keyboard hint', byId.get('exrail').querySelector('.brkeys').textContent],
    ['the sort options', byId.get('exsort').textContent],
    ['the lead card', byId.get('view').textContent],
  ]) assert.match(text, /[가-힣]/, `${what} is still in English`);
  // The ROWS are the engine's own ids and are relayed, never translated.
  assert.deepEqual(rowsOf(byId, 'exlist').map((r) => r.title), ['gamma_order', 'gamma_item', 'gamma_audit']);
  assert.equal(ev(ctx, 'JSON.stringify([...I18N.t.missing])'), '[]');
  assert.equal(ev(ctx, 'JSON.stringify([...I18N.t.fellBack])'), '[]');
});

test('the arrow keys move the highlight, Enter picks, and neither asks the server anything on the way', async (t) => {
  const { ctx, byId, calls } = await bootPage(t, { ids: ['gamma'], hash: '#p=gamma&tab=explore' });
  const q = byId.get('q');
  assert.equal(ev(ctx, 'RAIL.explore.cur'), 0, 'the first row is highlighted as soon as the list lands');
  calls.length = 0;
  fire(q, 'keydown', { key: 'ArrowDown' });
  assert.equal(ev(ctx, 'RAIL.explore.cur'), 1);
  fire(q, 'keydown', { key: 'ArrowDown' });
  assert.equal(ev(ctx, 'RAIL.explore.cur'), 2);
  fire(q, 'keydown', { key: 'ArrowUp' });
  assert.equal(ev(ctx, 'RAIL.explore.cur'), 1);
  assert.deepEqual(rowsOf(byId, 'exlist').filter((r) => r.classList.contains('cur')).map((r) => r.title), ['gamma_item']);
  assert.deepEqual(toolCalls(calls), [], 'moving the highlight asks nothing');

  fire(q, 'keydown', { key: 'Enter' });
  await settle(ctx, 8);
  assert.deepEqual(toolCalls(calls, 'table_usage'),
    [{ name: 'table_usage', args: { table: 'gamma_item' } }]);
  assert.deepEqual(toolCalls(calls, 'search'), [], 'Enter took the highlighted row, so it never fell back to a search');
});

test('the quick picks are the top of the list already loaded, and cost no request of their own', async (t) => {
  const { ctx, byId, calls } = await bootPage(t, { ids: ['gamma'], hash: '#p=gamma&tab=explore' });
  const card = byId.get('view').querySelector('.brlead');
  assert.ok(card, 'the right-hand side carries the lead card, not a grey box telling you to type');
  assert.match(card.textContent, /Pick a table, column or statement/);
  const picks = card.querySelectorAll('.brpick').map((b) => b.querySelector('.brid').textContent);
  assert.ok(picks.length > 0 && picks.length <= 5, `${picks.length} quick picks`);
  const loaded = ev(ctx, 'JSON.stringify(RAIL.explore.rows.map((r)=>r.table))');
  assert.deepEqual(picks, JSON.parse(loaded).slice(0, 5), 'the five busiest, off the rows already here');
  for (const p of picks) assert.ok(JSON.parse(loaded).includes(p), `${p} is not one of the loaded rows`);

  // Clicking one is the same as clicking its row.
  calls.length = 0;
  card.querySelectorAll('.brpick')[0].click();
  await settle(ctx, 8);
  assert.deepEqual(toolCalls(calls, 'table_usage'),
    [{ name: 'table_usage', args: { table: 'gamma_order' } }]);
});

test('a pack with no code axis says the Java lane did not run, and still lists what it does have', async (t) => {
  const { ctx, byId } = await bootPage(t, { hash: '#p=alpha&tab=flow' });
  await settle(ctx, 6);
  assert.deepEqual(rowsOf(byId, 'flist'), []);
  assert.match(byId.get('flist').textContent, /not shipped: this project was analysed without the Java side/);
  assert.equal(ev(ctx, "RAIL.flow.resp.answer.empty.items"), 'not-shipped',
    "the page prints the ENGINE's own reason, it does not decide one");
  // Explore, on the same pack, still opens on its tables.
  ev(ctx, `document.querySelector('.tab[data-tab="explore"]').click()`);
  await settle(ctx, 8);
  assert.deepEqual(rowsOf(byId, 'exlist').map((r) => r.title), ['alpha_order']);
  assert.equal(byId.get('exkinds').children[3].textContent, 'Endpoints0', 'zero endpoints, said as a zero');
});

test('the rail is a browse ANSWER, never a count the page did: every number on it comes off the wire', async (t) => {
  const { ctx, byId } = await bootPage(t, { ids: ['gamma'], hash: '#p=gamma&tab=explore' });
  const answer = JSON.parse(ev(ctx, 'JSON.stringify(RAIL.explore.resp.answer)'));
  assert.deepEqual(answer.counts, { table: 3, column: 4, statement: 3, endpoint: 3, symbol: 10, screen: 0 });
  assert.equal(answer.total, 3);
  // The stat chips beside a row are that row's own fields, not a re-derivation.
  const first = answer.items[0];
  assert.deepEqual([first.table, first.statementsRead, first.statementsWrite, first.endpoints],
    ['gamma_order', 1, 1, 2]);
  const chips = rowsOf(byId, 'exlist')[0].querySelectorAll('.brstat').map((c) => c.textContent);
  assert.deepEqual(chips, ['sql2', 'api2'], 'statements touching, then endpoints reaching, each with its own label');
  // ...and each one says what it counts.
  const titles = rowsOf(byId, 'exlist')[0].querySelectorAll('.brstat').map((c) => c.title);
  assert.match(titles[0], /how many SQL statements touch this/);
  assert.match(titles[1], /mode=conservative, depth 8/);
});

// ---------------------------------------------------------------------------
// RM27b: the source pane, one way back, and labels instead of glyphs.
//
// The picture is the CLAIM and the source is the EVIDENCE, so the evidence is
// read at reading size where the claim is made; every narrowing has ONE visible
// way back, the same on every tab; and a row's numbers say what they count.
// ---------------------------------------------------------------------------

/** The source requests this page has made, in order. */
const srcCalls = (calls) => calls.filter((c) => c.url.startsWith('/api/source')).map((c) => c.url);
/** The pane's gutter, as the numbers a reader sees, and which of them are marked. */
const gutter = (byId) => byId.get('srcbody').querySelectorAll('.srcln')
  .map((row) => ({ no: row.querySelector('.srcno').textContent, hi: row.classList.contains('hi') }));
/** Open the Explore rail on one kind and click the row whose id is `id`. */
async function pickStatement(ctx, byId, id) {
  ev(ctx, "railSetKind('explore','statement')");
  await settle(ctx, 10);
  const row = rowsOf(byId, 'exlist').find((r) => r.title === id);
  assert.ok(row, `no rail row for ${id}: ${rowsOf(byId, 'exlist').map((r) => r.title).join(', ')}`);
  row.click();
  await settle(ctx, 10);
}

test('a source opens INTO THE PANE: one request, a gutter of real file lines, and the range marked', async (t) => {
  const { ctx, byId, calls, html } = await bootPage(t, { ids: ['gamma'], hash: '#p=gamma&tab=explore' });
  calls.length = 0;
  await pickStatement(ctx, byId, 'com.g.GMapper.selectOrder');

  // ONE request, and it names the NODE rather than asking for a file: the page
  // does not know which file a statement is in, and must not guess.
  assert.equal(srcCalls(calls).length, 1, `source requests: ${srcCalls(calls).join(', ')}`);
  assert.match(srcCalls(calls)[0], /^\/api\/source\?node=statement%3Acom\.g\.GMapper\.selectOrder/);
  assert.equal(/whole=1/.test(srcCalls(calls)[0]), false, 'the snippet is the default');

  assert.equal(byId.get('srcpane').classList.contains('hidden'), false, 'the pane is on screen');
  assert.equal(Number(ev(ctx, "document.querySelectorAll('.srcpane').length")), 1, 'and there is exactly one of it');
  // The gutter carries the FILE's own line numbers, not 1..n of the snippet,
  // and every line of the cut is marked.
  assert.deepEqual(gutter(byId), [
    { no: '3', hi: true }, { no: '4', hi: true }, { no: '5', hi: true },
  ]);
  assert.match(byId.get('srcbody').textContent, /SELECT id, total FROM gamma_order/);

  // The header: the node, the path AND the line, the language, the range.
  const head = byId.get('srchd');
  assert.equal(head.querySelector('.srcnode').textContent, 'statement:com.g.GMapper.selectOrder');
  assert.equal(head.querySelector('.srcpath').textContent, 'GMapper.xml:3');
  assert.equal(head.querySelector('.tag').textContent, 'xml');
  assert.equal(head.querySelector('.srcrange').textContent, 'lines 3 to 5');

  // The scrolling code box it replaces is GONE from the page, not left beside it.
  assert.equal(/pre\.code/.test(html), false, 'the 286 by 360 pixel preview is not still in the stylesheet');
});

test('the whole-file toggle asks ONCE more, keeps the same marked range, and asks nothing on the way back', async (t) => {
  const { ctx, byId, calls } = await bootPage(t, { ids: ['gamma'], hash: '#p=gamma&tab=explore' });
  await pickStatement(ctx, byId, 'com.g.GMapper.selectOrder');
  calls.length = 0;

  const whole = byId.get('srchd').querySelector('.seg').children[1];
  assert.equal(whole.textContent, 'whole file');
  whole.click();
  await settle(ctx, 10);

  assert.equal(srcCalls(calls).length, 1, `the toggle asked ${srcCalls(calls).length} times`);
  assert.match(srcCalls(calls)[0], /whole=1/);
  const g = gutter(byId);
  assert.equal(g[0].no, '1', 'the whole file starts at the top of the file');
  assert.equal(g.length, 13, '...and runs to the end of it');
  assert.deepEqual(g.filter((x) => x.hi).map((x) => x.no), ['3', '4', '5'],
    'the whole-file view marks the very lines the snippet was');
  assert.equal(byId.get('srchd').querySelector('.srcrange').textContent, 'lines 3 to 5 of 13');

  // ...and back to the snippet, off the answer already in memory.
  calls.length = 0;
  byId.get('srchd').querySelector('.seg').children[0].click();
  await settle(ctx, 8);
  assert.deepEqual(srcCalls(calls), [], 'an answer already read is not read again');
  assert.deepEqual(gutter(byId).map((x) => x.no), ['3', '4', '5']);
});

test('a second pick REPLACES the pane, never opens a second one, and Escape closes it', async (t) => {
  const { ctx, byId, calls, fireDoc } = await bootPage(t, { ids: ['gamma'], hash: '#p=gamma&tab=explore' });
  await pickStatement(ctx, byId, 'com.g.GMapper.selectOrder');
  calls.length = 0;

  rowsOf(byId, 'exlist').find((r) => r.title === 'com.g.GMapper.updateOrder').click();
  await settle(ctx, 10);

  assert.equal(Number(ev(ctx, "document.querySelectorAll('.srcpane').length")), 1, 'one pane, still');
  assert.equal(srcCalls(calls).length, 1, 'one request for the new node, and no more');
  assert.equal(ev(ctx, 'SRC.node'), 'statement:com.g.GMapper.updateOrder');
  assert.deepEqual(gutter(byId).map((x) => x.no), ['6', '7', '8'], 'the new statement, at its own lines');

  fireDoc('keydown', { key: 'Escape' });
  await settle(ctx, 4);
  assert.equal(ev(ctx, 'SRC.open'), false);
  assert.equal(byId.get('srcpane').classList.contains('hidden'), true);
  assert.equal(/&src=/.test(ev(ctx, 'location.hash')), false, 'and the URL stops naming a source');
});

test("the editor control remembers the reader's editor, and its link carries that editor's scheme", async (t) => {
  const { ctx, byId, store } = await bootPage(t, { ids: ['gamma'], hash: '#p=gamma&tab=explore' });
  await pickStatement(ctx, byId, 'com.g.GMapper.selectOrder');

  const sel = byId.get('srchd').querySelector('select');
  assert.deepEqual(sel.children.map((o) => o.textContent), ['VS Code', 'IntelliJ IDEA', 'none']);
  const link = () => byId.get('srchd').querySelector('.srcopen');
  // The ABSOLUTE path is the SERVER's — this page never builds one — so the
  // link can only be right if /api/source answered it.
  assert.match(link().getAttribute('href'), /^vscode:\/\/file\/.*\/GMapper\.xml:3:1$/);

  sel.value = 'idea';
  sel.onchange({ target: sel });
  assert.equal(store.get('cascade.viewer.editor'), 'idea', 'the choice is remembered');
  assert.match(link().getAttribute('href'), /^idea:\/\/open\?file=.*GMapper\.xml&line=3$/);

  // `none` is not a link at all: there is nothing to open, so it copies instead.
  sel.value = 'none';
  sel.onchange({ target: sel });
  assert.equal(byId.get('srchd').querySelector('.srcopen'), null);
  assert.equal(byId.get('srchd').querySelectorAll('button.mini').map((b) => b.textContent).includes('Copy path'), true);

  // ...and a reader who comes back tomorrow gets the editor they chose.
  const again = await bootPage(t, { ids: ['gamma'], hash: '#p=gamma&tab=explore', storage: { 'cascade.viewer.editor': 'idea' } });
  await pickStatement(again.ctx, again.byId, 'com.g.GMapper.selectOrder');
  assert.match(again.byId.get('srchd').querySelector('.srcopen').getAttribute('href'), /^idea:\/\/open/);
});

test('the pane remembers how wide the reader made it, inside its own floor and ceiling', async (t) => {
  const { ctx, byId, store } = await bootPage(t, { ids: ['gamma'], hash: '#p=gamma&tab=explore' });
  await pickStatement(ctx, byId, 'com.g.GMapper.selectOrder');
  // 1400px of window: the default is 56vw, and the pane is docked, not floating.
  assert.equal(byId.get('srcpane').style.width, '784px');

  assert.equal(Number(ev(ctx, 'srcSetWidth(500)')), 500);
  assert.equal(store.get('cascade.viewer.srcpane.w'), '500');
  assert.equal(Number(ev(ctx, 'srcSetWidth(80)')), 420, 'narrower than the floor is the floor');
  assert.equal(Number(ev(ctx, 'srcSetWidth(9000)')), 1260, '...and wider than 90vw is 90vw');

  const remembered = await bootPage(t, { ids: ['gamma'], hash: '#p=gamma&tab=explore', storage: { 'cascade.viewer.srcpane.w': '620' } });
  await pickStatement(remembered.ctx, remembered.byId, 'com.g.GMapper.selectOrder');
  assert.equal(remembered.byId.get('srcpane').style.width, '620px');
});

test("the rail's stat chips are LABELLED, one label set per kind, and a label is not translated", async (t) => {
  const { ctx, byId } = await bootPage(t, { ids: ['gamma'], hash: '#p=gamma&tab=explore' });
  const chips = () => rowsOf(byId, 'exlist')[0].querySelectorAll('.brstat')
    .map((c) => [c.querySelector('.brlbl').textContent, c.textContent]);
  const kind = async (k) => { ev(ctx, `railSetKind('explore','${k}')`); await settle(ctx, 10); };

  // tables: how much SQL touches it, how many endpoints reach it.
  assert.deepEqual(chips(), [['sql', 'sql2'], ['api', 'api2']]);
  await kind('column');
  assert.deepEqual(chips().map((x) => x[0]), ['r', 'w', 'api']);
  await kind('statement');
  assert.deepEqual(chips().map((x) => x[0]), ['tbl', 'api']);
  await kind('endpoint');
  assert.deepEqual(chips().map((x) => x[0]), ['sql', 'tbl']);

  // The labels are the ENGINE's own nouns, so a language switch does not move
  // them; the SENTENCE that says what each counts is the page's, and does.
  const before = chips();
  byId.get('langseg').children[1].onclick();
  await settle(ctx, 8);
  assert.deepEqual(chips(), before, 'a label is a noun the engine owns');
  assert.match(rowsOf(byId, 'exlist')[0].querySelectorAll('.brstat')[0].title, /[가-힣]/,
    '...and the title that says what it counts is translated');
});

test('the kind chips WRAP evenly instead of scrolling a chip off the rail', async (t) => {
  const { html, byId } = await bootPage(t, { ids: ['gamma'], hash: '#p=gamma&tab=explore' });
  assert.equal(byId.get('exkinds').children.length, 6, 'six chips, all of them rendered');
  const css = html.slice(html.indexOf('.brkinds {'), html.indexOf('.brfilter {'));
  assert.match(css, /grid-template-columns:repeat\(auto-fit, minmax\(92px, 1fr\)\)/,
    'equal cells that wrap, so six chips read as two rows of three');
  assert.equal(/overflow-x:auto/.test(css), false, 'the scrolling strip is gone');
  assert.equal(/mask-image/.test(css), false, '...and so is the fade that hid the last chip');
});

test('the rail connects its endpoint count to the masthead\'s, because they are not the same number', async (t) => {
  // gamma serves three endpoints and calls none it does not serve, so nothing
  // is said: the sentence exists only when there IS a difference.
  const { ctx, byId } = await bootPage(t, { ids: ['gamma'], hash: '#p=gamma&tab=explore' });
  assert.equal(ev(ctx, "String(railOutboundNote('explore'))"), 'null');
  assert.equal(byId.get('exkinds').children[3].title, '', 'no difference, no sentence');

  // Now the census the OVERVIEW answered says four and browse still says three:
  // the one in between is a route this pack calls and does not serve.
  ev(ctx, "OV.resp.answer.nodes.find((n)=>n.kind==='endpoint').count = 4; railSetKind('explore','endpoint');");
  await settle(ctx, 12);
  const want = '3 served; 1 more are routes this pack calls and does not serve';
  assert.equal(ev(ctx, "railOutboundNote('explore')"), want);
  assert.equal(byId.get('exkinds').children[3].title, want, 'the Endpoints chip says it');
  assert.match(byId.get('excount').textContent, /3 shown of 3/);
  assert.match(byId.get('excount').textContent, /1 more are routes/, 'and so does the count line');
});

test('Show all is disabled while a tab IS its opening state', async (t) => {
  const { ctx, byId } = await bootPage(t, { ids: ['gamma'], hash: '#p=gamma&tab=explore' });
  for (const [tab, id] of [['explore', 'exshowall'], ['flow', 'fshowall'], ['impact', 'ishowall'], ['erd', 'eshowall']]) {
    ev(ctx, `activateTab('${tab}')`);
    await settle(ctx, 10);
    assert.equal(byId.get(id).disabled, true, `${tab} says it is narrowed when it is not`);
  }
});

test('Show all puts Explore, Flow and Impact back where they opened, and says so in the URL', async (t) => {
  const { ctx, byId, calls } = await bootPage(t, { ids: ['gamma'], hash: '#p=gamma&tab=explore' });

  // EXPLORE: a filter, a pick and the source pane are three narrowings at once.
  const q = byId.get('q');
  q.value = 'order'; fire(q, 'input');
  await settle(ctx, 30);
  await pickStatement(ctx, byId, 'com.g.GMapper.selectOrder');
  assert.equal(byId.get('exshowall').disabled, false);
  assert.match(ev(ctx, 'location.hash'), /pick=statement/);
  assert.match(ev(ctx, 'location.hash'), /src=statement/);

  calls.length = 0;
  byId.get('exshowall').click();
  await settle(ctx, 10);
  assert.equal(byId.get('q').value, '', 'the filter is cleared');
  assert.equal(ev(ctx, 'RAIL.explore.sel'), null, 'nothing is picked');
  assert.equal(ev(ctx, 'SRC.open'), false, 'the source pane is closed');
  assert.ok(byId.get('view').querySelector('.brlead'), 'the quick-picks card is back');
  assert.equal(ev(ctx, 'location.hash'), '#p=gamma&tab=explore', 'and the URL says so');
  assert.equal(byId.get('exshowall').disabled, true, 'the control reports the state it produced');
  assert.deepEqual(toolCalls(calls), [], 'putting a tab back asks the server for nothing');

  // FLOW: a picture drawn, and a group folded shut.
  ev(ctx, "activateTab('flow')");
  await settle(ctx, 10);
  rowsOf(byId, 'flist')[0].click();
  await settle(ctx, 14);
  ev(ctx, "RAIL.flow.closedGroups.add('order'); railRenderRows('flow')");
  assert.equal(byId.get('fshowall').disabled, false);
  byId.get('fshowall').click();
  await settle(ctx, 8);
  assert.equal(ev(ctx, 'FLOWV.resp'), null, 'the picture is cleared');
  assert.equal(Number(ev(ctx, 'RAIL.flow.closedGroups.size')), 0, 'every group is open again');
  assert.equal(byId.get('fentry').value, '');
  assert.ok(byId.get('flowwrap').querySelector('.brlead'), 'and the lead card is back on the canvas');
  assert.equal(byId.get('fshowall').disabled, true);

  // IMPACT: a table unfolded into its own columns.
  ev(ctx, "activateTab('impact')");
  await settle(ctx, 10);
  byId.get('ilist').querySelectorAll('.brcaret')[0].click();
  await settle(ctx, 10);
  assert.equal(Number(ev(ctx, 'RAIL.impact.openTables.size')), 1);
  assert.equal(byId.get('ishowall').disabled, false);
  byId.get('ishowall').click();
  await settle(ctx, 8);
  assert.equal(Number(ev(ctx, 'RAIL.impact.openTables.size')), 0, 'folded back');
  assert.deepEqual(byId.get('ilist').querySelectorAll('.brchild'), []);
  assert.equal(byId.get('ishowall').disabled, true);
});

test('Show all folds the Graph map back and clears the ERD highlight', async (t) => {
  // GRAPH: an unfolded map, a spotlight and a focus typed in are all narrowings.
  const g = await withMap(t);
  assert.equal(g.byId.get('gshowall').disabled, true, 'the map at rest is not narrowed');
  ev(g.ctx, "mapUnfoldAll(); GMAP.sel='table:t1'; byId('gfocus').value='t1'; refreshShowAll();");
  assert.equal(g.byId.get('gshowall').disabled, false);
  g.byId.get('gshowall').click();
  await settle(g.ctx, 8);
  assert.equal(Number(ev(g.ctx, 'GMAP.open.size')), 0, 'every group folded');
  assert.equal(ev(g.ctx, 'GMAP.sel'), null, 'the spotlight cleared');
  assert.equal(g.byId.get('gfocus').value, '', 'and the find box emptied');
  assert.equal(g.byId.get('gshowall').disabled, true);

  // ERD: a highlighted table.
  const e = await bootPage(t, { ids: ['gamma'], hash: '#p=gamma&tab=erd' });
  await settle(e.ctx, 12);
  ev(e.ctx, "ERD.sel='gamma_order'; byId('etable').value='gamma_order'; refreshShowAll();");
  assert.equal(e.byId.get('eshowall').disabled, false);
  e.byId.get('eshowall').click();
  await settle(e.ctx, 8);
  assert.equal(ev(e.ctx, 'ERD.sel'), null);
  assert.equal(e.byId.get('etable').value, '');
  assert.equal(e.byId.get('eshowall').disabled, true);
});

test('Escape is TWO steps while a box has the focus: the box first, the tab second', async (t) => {
  const { ctx, byId, fireDoc } = await bootPage(t, { ids: ['gamma'], hash: '#p=gamma&tab=explore' });
  rowsOf(byId, 'exlist')[0].click();
  await settle(ctx, 10);
  const q = byId.get('q');
  q.value = 'gamma'; fire(q, 'input');
  await settle(ctx, 30);

  fireDoc('keydown', { key: 'Escape', target: q });
  await settle(ctx, 6);
  assert.equal(q.value, '', 'the first Escape empties the box the reader was typing in');
  assert.equal(ev(ctx, 'RAIL.explore.sel'), 'gamma_order', '...and leaves the pick alone');

  fireDoc('keydown', { key: 'Escape', target: q });
  await settle(ctx, 8);
  assert.equal(ev(ctx, 'RAIL.explore.sel'), null, 'the second one puts the tab back');
  assert.equal(byId.get('exshowall').disabled, true);
});

test('clicking the tab you are already on puts it back; clicking another one does not', async (t) => {
  const { ctx, byId, body } = await bootPage(t, { ids: ['gamma'], hash: '#p=gamma&tab=explore' });
  rowsOf(byId, 'exlist')[0].click();
  await settle(ctx, 10);
  assert.equal(ev(ctx, 'RAIL.explore.sel'), 'gamma_order');

  // Another tab is a MOVE, not a reset: Explore keeps its pick for the way back.
  body.querySelector('.tab[data-tab="flow"]').click();
  await settle(ctx, 10);
  assert.equal(ev(ctx, 'RAIL.explore.sel'), 'gamma_order', 'leaving a tab keeps its last pick');
  body.querySelector('.tab[data-tab="explore"]').click();
  await settle(ctx, 8);
  assert.equal(ev(ctx, 'RAIL.explore.sel'), 'gamma_order', 'and coming back keeps it too');

  // The tab you are ON: the gesture every reader already tries.
  body.querySelector('.tab[data-tab="explore"]').click();
  await settle(ctx, 8);
  assert.equal(ev(ctx, 'RAIL.explore.sel'), null);
  assert.equal(ev(ctx, 'location.hash'), '#p=gamma&tab=explore');
});

test('a pick writes the URL, and Back puts the previous picture up without asking for it again', async (t) => {
  const { ctx, byId, calls, fireWindow } = await bootPage(t, { ids: ['gamma'], hash: '#p=gamma&tab=explore' });
  rowsOf(byId, 'exlist')[0].click();
  await settle(ctx, 10);
  assert.equal(ev(ctx, 'location.hash'), '#p=gamma&tab=explore&pick=table%3Agamma_order');
  rowsOf(byId, 'exlist')[1].click();
  await settle(ctx, 10);
  assert.equal(ev(ctx, 'location.hash'), '#p=gamma&tab=explore&pick=table%3Agamma_item');

  // The Back button. The stub's history keeps no stack of its own, so the URL
  // is put back the way a browser would and `popstate` is delivered, which is
  // exactly what the page listens for.
  calls.length = 0;
  ev(ctx, "location.hash='#p=gamma&tab=explore&pick=table%3Agamma_order'");
  fireWindow('popstate');
  await settle(ctx, 10);
  assert.deepEqual(toolCalls(calls), [], 'the answer was still in memory, so nothing was asked');
  assert.equal(ev(ctx, 'PICK.explore'), 'table:gamma_order');
  assert.match(byId.get('view').textContent, /gamma_order/);
  assert.deepEqual(rowsOf(byId, 'exlist').filter((r) => r.getAttribute('aria-selected') === 'true').map((r) => r.title),
    ['gamma_order'], 'and the rail row is marked again');

  // One more step back is the opening state, and that costs nothing either.
  calls.length = 0;
  ev(ctx, "location.hash='#p=gamma&tab=explore'");
  fireWindow('popstate');
  await settle(ctx, 8);
  assert.deepEqual(toolCalls(calls), []);
  assert.equal(ev(ctx, 'PICK.explore'), null);
  assert.ok(byId.get('view').querySelector('.brlead'));
});

test('a deep link that names a pick and a source lands on both', async (t) => {
  const { ctx, byId, calls } = await bootPage(t, {
    ids: ['gamma'],
    hash: '#p=gamma&tab=explore&pick=statement%3Acom.g.GMapper.updateOrder&src=statement%3Acom.g.GMapper.updateOrder',
  });
  await settle(ctx, 14);
  assert.equal(ev(ctx, 'SRC.open'), true, 'the pane is open on the node the link named');
  assert.equal(ev(ctx, 'SRC.node'), 'statement:com.g.GMapper.updateOrder');
  assert.deepEqual(gutter(byId).map((x) => x.no), ['6', '7', '8']);
  assert.equal(ev(ctx, 'PICK.explore'), 'statement:com.g.GMapper.updateOrder');
  assert.equal(srcCalls(calls).length, 1, 'a cold load asks once, and only once');
});

test('a Java handler opens at its own method, and the pane paints comments and strings only', async (t) => {
  const { ctx, byId } = await bootPage(t, { ids: ['gamma'], hash: '#p=gamma&tab=explore' });
  ev(ctx, "srcOpen('endpoint:GET /order/{id}', {tab:'explore'})");
  await settle(ctx, 10);
  // gamma's endpoint records line 20, and the extractor closes the method at
  // its balanced brace: the gutter says which lines those are.
  assert.deepEqual(gutter(byId).map((x) => x.no), ['20', '21', '22']);
  assert.equal(byId.get('srchd').querySelector('.tag').textContent, 'java');
  assert.match(byId.get('srchd').querySelector('.srcpath').textContent, /src\/GController\.java:20$/);

  // The colouring is three regexes and nothing cleverer. Over the whole file a
  // `//` line is a comment; nothing else in this Java file is painted at all.
  ev(ctx, 'srcToggleWhole()');
  await settle(ctx, 10);
  const painted = byId.get('srcbody').querySelectorAll('.srccm').map((n) => n.textContent);
  assert.ok(painted.length > 0 && painted.every((x) => x.startsWith('//')), painted.join(' | '));
  assert.deepEqual(byId.get('srcbody').querySelectorAll('.srctg'), [], 'a Java file has no XML tags in it');
});

test('two callers asking for the same file at once put ONE request on the wire', async (t) => {
  // A chain card opens the pane on a statement by itself, and the reader may
  // press `Source` a moment later: the same file, asked for twice before the
  // first answer lands, must not be two requests.
  const { ctx, byId, calls } = await bootPage(t, { ids: ['gamma'], hash: '#p=gamma&tab=explore' });
  calls.length = 0;
  ev(ctx, "srcOpen('statement:com.g.GMapper.insertItem', {tab:'explore'}); srcOpen('statement:com.g.GMapper.insertItem', {tab:'explore'});");
  await settle(ctx, 12);
  assert.equal(srcCalls(calls).length, 1, `source requests: ${srcCalls(calls).join(', ')}`);
  assert.deepEqual(gutter(byId).map((x) => x.no), ['9', '10', '11']);

  // ...and asking again once it HAS landed is not a request either.
  calls.length = 0;
  ev(ctx, "srcOpen('statement:com.g.GMapper.insertItem', {tab:'explore'})");
  await settle(ctx, 8);
  assert.deepEqual(srcCalls(calls), []);
});

test('Show all puts the rail back on the kind the tab OPENED on, and asks nothing to do it', async (t) => {
  const { ctx, byId, calls } = await bootPage(t, { ids: ['gamma'], hash: '#p=gamma&tab=explore' });
  // Explore opens on Tables. Drill into Statements, pick one, then ask for the
  // whole tab back: the first screen is the list the tab opened with.
  await pickStatement(ctx, byId, 'com.g.GMapper.selectOrder');
  assert.equal(ev(ctx, 'RAIL.explore.kind'), 'statement');
  assert.equal(byId.get('exkinds').children[2].className, 'on', 'the Statements chip is the lit one');

  calls.length = 0;
  byId.get('exshowall').click();
  await settle(ctx, 10);
  assert.equal(ev(ctx, 'RAIL.explore.kind'), 'table', 'the kind is part of the opening state');
  assert.equal(byId.get('exkinds').children[0].className, 'on', 'and the chip strip says so');
  assert.deepEqual(rowsOf(byId, 'exlist').map((r) => r.title), ['gamma_order', 'gamma_item', 'gamma_audit']);
  assert.deepEqual(toolCalls(calls), [],
    'the answer for the opening kind was already read once, so this costs nothing');
  assert.equal(byId.get('exshowall').disabled, true);

  // Impact opens on Tables too, and its own sort ("endpoints") comes back with it.
  ev(ctx, "activateTab('impact')");
  await settle(ctx, 12);
  ev(ctx, "railSetKind('impact','statement')");
  await settle(ctx, 12);
  assert.equal(ev(ctx, 'RAIL.impact.kind'), 'statement');
  calls.length = 0;
  byId.get('ishowall').click();
  await settle(ctx, 10);
  assert.equal(ev(ctx, 'RAIL.impact.kind'), 'table');
  assert.equal(ev(ctx, 'RAIL.impact.sort'), 'endpoints', "...with this tab's own default sort");
  assert.deepEqual(toolCalls(calls), []);
});

test('a kind the rail has already shown is drawn from memory, not asked for again', async (t) => {
  const { ctx, byId, calls } = await bootPage(t, { ids: ['gamma'], hash: '#p=gamma&tab=explore' });
  calls.length = 0;
  ev(ctx, "railSetKind('explore','column')");
  await settle(ctx, 12);
  assert.deepEqual(toolCalls(calls, 'browse').map((c) => c.args.kind), ['column'], 'a kind never asked for is a request');

  calls.length = 0;
  ev(ctx, "railSetKind('explore','table')");
  await settle(ctx, 10);
  assert.deepEqual(toolCalls(calls), [], 'going back to a list already read asks nothing');
  assert.deepEqual(rowsOf(byId, 'exlist').map((r) => r.title), ['gamma_order', 'gamma_item', 'gamma_audit']);
  assert.equal(byId.get('excount').textContent, '3 shown of 3');
});

test('a statement or a method row reads SHORT, with the full id one hover away', async (t) => {
  const { ctx, byId } = await bootPage(t, { ids: ['gamma'], hash: '#p=gamma&tab=explore' });
  ev(ctx, "railSetKind('explore','statement')");
  await settle(ctx, 12);
  const rows = rowsOf(byId, 'exlist');
  // The list is 320px wide and every one of these shares `com.g.GMapper.`: the
  // prefix is what an ellipsis would have kept and the name is what it cut.
  assert.deepEqual(rows.map((r) => r.querySelector('.brid').textContent).sort(),
    ['GMapper.insertItem', 'GMapper.selectOrder', 'GMapper.updateOrder']);
  assert.deepEqual(rows.map((r) => r.title).sort(),
    ['com.g.GMapper.insertItem', 'com.g.GMapper.selectOrder', 'com.g.GMapper.updateOrder'],
    'the full id is still what the row is titled');
  // ...and it is still what the filter matches, so a package name finds rows.
  const q = byId.get('q');
  q.value = 'com.g'; fire(q, 'input');
  await settle(ctx, 30);
  assert.equal(rowsOf(byId, 'exlist').length, 3, 'filtering on the prefix still finds them');

  // A METHOD reads owner#name, the same rule the chain lanes use.
  q.value = ''; fire(q, 'input');
  await settle(ctx, 30);
  ev(ctx, "railSetKind('explore','symbol')");
  await settle(ctx, 6);
  byId.get('q').value = 'GController';
  fire(byId.get('q'), 'input');
  await settle(ctx, 90);   // kind=symbol is the one filter that IS a query (250ms)
  const syms = rowsOf(byId, 'exlist');
  assert.ok(syms.length > 0, 'the method list answered');
  assert.deepEqual(syms.map((r) => r.querySelector('.brid').textContent).sort(),
    ['GController#get', 'GController#save']);
  assert.deepEqual(syms.map((r) => r.title).sort(),
    ['com.g.GController#get', 'com.g.GController#save']);
  // The page names one thing ONE way: this is `shortId`, not a second rule.
  assert.equal(ev(ctx, "shortId('symbol:com.g.GController#get')"), 'GController#get');
  assert.equal(ev(ctx, "shortId('statement:com.g.GMapper.selectOrder')"), 'GMapper.selectOrder');
});

test('the quick picks read the same way the rows do, full id and all', async (t) => {
  const { ctx, byId } = await bootPage(t, { ids: ['gamma'], hash: '#p=gamma&tab=explore' });
  ev(ctx, "railSetKind('explore','statement')");
  await settle(ctx, 12);
  const picks = byId.get('view').querySelector('.brlead').querySelectorAll('.brpick');
  assert.ok(picks.length > 0);
  assert.deepEqual(picks.map((b) => b.querySelector('.brid').textContent).sort(),
    ['GMapper.insertItem', 'GMapper.selectOrder', 'GMapper.updateOrder']);
  assert.deepEqual(picks.map((b) => b.title).sort(),
    ['com.g.GMapper.insertItem', 'com.g.GMapper.selectOrder', 'com.g.GMapper.updateOrder']);
});

test('the pane opens only when it is ASKED for, then follows; a closed one stays closed', async (t) => {
  // The IDE rule. A chain row carries a card and an evidence rail (the path
  // down from the entry, the grade sentences), and a pane that opened by itself
  // covered the very thing the reader clicked the row to read.
  const { ctx, byId, calls } = await bootPage(t, { ids: ['gamma'], hash: '#p=gamma&tab=flow' });
  // The depth picker's value is its option TEXT, which this parser does not
  // keep: say it, or the walk is asked for at depth 0 and refused.
  byId.get('fdepth').value = '6';
  rowsOf(byId, 'flist')[0].click();
  await settle(ctx, 14);
  const statementRows = () => byId.get('flowwrap').querySelectorAll('.frow')
    .filter((r) => String(r.textContent).includes('GMapper'));
  assert.ok(statementRows().length >= 2, `the chain drew ${statementRows().length} mapper rows: ${byId.get('flowwrap').textContent.slice(0, 200)}`);

  // 1. A row picked with the pane CLOSED asks for no source and opens nothing.
  calls.length = 0;
  fire(statementRows()[0], 'click');
  await settle(ctx, 12);
  assert.deepEqual(srcCalls(calls), [], 'a chain row is not a request for the source');
  assert.equal(ev(ctx, 'SRC.open'), false);
  assert.equal(byId.get('srcpane').classList.contains('hidden'), true, 'the pane stayed shut');
  const card = () => byId.get('flowside').querySelectorAll('button.mini').find((b) => b.textContent === 'Source');
  assert.ok(card(), 'the card offers the way in');

  // 2. Pressing Source is the request: one, and the pane opens.
  calls.length = 0;
  card().click();
  await settle(ctx, 12);
  assert.equal(srcCalls(calls).length, 1, `source requests: ${srcCalls(calls).join(', ')}`);
  assert.equal(ev(ctx, 'SRC.open'), true);
  const first = ev(ctx, 'SRC.node');

  // 3. With it open, the next row FOLLOWS in place: one request, one pane.
  calls.length = 0;
  fire(statementRows()[1], 'click');
  await settle(ctx, 12);
  assert.equal(srcCalls(calls).length, 1, 'the pane followed the pick');
  assert.equal(Number(ev(ctx, "document.querySelectorAll('.srcpane').length")), 1);
  assert.notEqual(ev(ctx, 'SRC.node'), first, 'and it is showing the row that was just picked');

  // 4. Closed by Escape, it stays closed: a later row asks for nothing.
  ev(ctx, 'srcClose()');
  await settle(ctx, 4);
  calls.length = 0;
  fire(statementRows()[0], 'click');
  await settle(ctx, 12);
  assert.deepEqual(srcCalls(calls), [], 'a pane the reader closed does not come back on its own');
  assert.equal(ev(ctx, 'SRC.open'), false);
  assert.equal(byId.get('srcpane').classList.contains('hidden'), true);
});

test('an Explore table pick follows an OPEN pane and leaves a closed one closed', async (t) => {
  const { ctx, byId, calls } = await bootPage(t, { ids: ['gamma'], hash: '#p=gamma&tab=explore' });
  // Closed: picking a table is a table answer, not a source request.
  calls.length = 0;
  rowsOf(byId, 'exlist')[0].click();
  await settle(ctx, 12);
  assert.deepEqual(srcCalls(calls), []);
  assert.equal(ev(ctx, 'SRC.open'), false);

  // Open it on a statement, come back to Tables, and the pane follows the pick.
  await pickStatement(ctx, byId, 'com.g.GMapper.selectOrder');
  assert.equal(ev(ctx, 'SRC.open'), true);
  ev(ctx, "railSetKind('explore','table')");
  await settle(ctx, 12);
  calls.length = 0;
  rowsOf(byId, 'exlist')[0].click();
  await settle(ctx, 12);
  assert.equal(ev(ctx, 'SRC.node'), 'table:gamma_order', 'the open pane followed the table');
  assert.equal(srcCalls(calls).length, 1);
});

test('a PICK is not a filter: a link that names one lands on the whole list, with that row marked', async (t) => {
  // The box on Flow and Impact does double duty — it filters the rail AND names
  // the chain to draw — so a restore from the hash WRITES the picked id into
  // it. Read back as a filter that showed one row and threw the list away.
  const flow = await bootPage(t, {
    ids: ['gamma'],
    hash: '#p=gamma&tab=flow&pick=endpoint%3APOST%20%2Forder%2Fsave',
  });
  await settle(flow.ctx, 16);
  const total = Number(ev(flow.ctx, 'RAIL.flow.resp.answer.total'));
  assert.equal(total, 3, 'gamma serves three endpoints');
  assert.equal(rowsOf(flow.byId, 'flist').length, total, 'every row the list holds is on screen');
  assert.equal(flow.byId.get('fcount').textContent, `${total} shown of ${total}`);
  assert.equal(flow.byId.get('fentry').value, 'POST /order/save', 'the box still names the chain');
  assert.equal(ev(flow.ctx, "RAIL.flow.typed"), '', 'and the page typing in it is not typing');
  assert.deepEqual(rowsOf(flow.byId, 'flist').filter((r) => r.getAttribute('aria-selected') === 'true').map((r) => r.title),
    ['POST /order/save'], 'the picked row is marked');
  assert.equal(Number(ev(flow.ctx, 'RAIL.flow.cur')), rowsOf(flow.byId, 'flist').findIndex((r) => r.title === 'POST /order/save'),
    '...and it keeps the highlight, so it is scrolled to rather than hunted for');
  // ...and the chain itself was asked for, from the pick the link named. (The
  // DRAWING needs the depth picker, whose value is its option text, and this
  // parser keeps no text nodes: the picture is checked in a real browser.)
  const drawn = toolCalls(flow.calls, 'flow').filter((c) => c.args.endpoint);
  assert.equal(drawn.length, 1, `the restore drew ${drawn.length} chains`);
  assert.equal(drawn[0].args.endpoint, 'POST /order/save');

  // The same on Impact, whose box is written by the restore too.
  const impact = await bootPage(t, { ids: ['gamma'], hash: '#p=gamma&tab=impact&pick=table%3Agamma_item' });
  await settle(impact.ctx, 16);
  assert.equal(rowsOf(impact.byId, 'ilist').length, Number(ev(impact.ctx, 'RAIL.impact.resp.answer.total')));
  assert.equal(impact.byId.get('ientry').value, 'gamma_item');
  assert.equal(ev(impact.ctx, "RAIL.impact.typed"), '');
  assert.deepEqual(rowsOf(impact.byId, 'ilist').filter((r) => r.getAttribute('aria-selected') === 'true').map((r) => r.title),
    ['gamma_item']);

  // ...and on Explore, where the same box is also the search box.
  const explore = await bootPage(t, { ids: ['gamma'], hash: '#p=gamma&tab=explore&pick=table%3Agamma_item' });
  await settle(explore.ctx, 16);
  assert.equal(rowsOf(explore.byId, 'exlist').length, 3);
  assert.equal(explore.byId.get('excount').textContent, '3 shown of 3');
  assert.deepEqual(rowsOf(explore.byId, 'exlist').filter((r) => r.getAttribute('aria-selected') === 'true').map((r) => r.title),
    ['gamma_item']);
});

test('a hand-off from another tab does not filter the rail it lands on either', async (t) => {
  const { ctx, byId } = await bootPage(t, { ids: ['gamma'], hash: '#p=gamma&tab=explore' });
  // Explore -> Impact, the way a table card's `Impact` button does it: the page
  // writes the table name into Impact's box.
  ev(ctx, "openImpact({table:'gamma_order'})");
  await settle(ctx, 16);
  assert.equal(byId.get('ientry').value, 'gamma_order');
  assert.equal(ev(ctx, "RAIL.impact.typed"), '');
  assert.equal(rowsOf(byId, 'ilist').length, 3, 'the whole list is still there');
  assert.equal(byId.get('icount').textContent, '3 shown of 3');

  // What the READER types still filters, and Escape gives the list back.
  const box = byId.get('ientry');
  box.value = 'gamma_item'; fire(box, 'input');
  await settle(ctx, 40);
  assert.equal(ev(ctx, "RAIL.impact.typed"), 'gamma_item');
  assert.deepEqual(rowsOf(byId, 'ilist').map((r) => r.title), ['gamma_item']);
});

// ---------------------------------------------------------------------------
// RM31: the SCREEN END, drawn. Every test below runs against `delta`, the pack
// with a frontend (see deltaFacts above): two screens, three frontend
// functions, two routes and one table, plus a recording that confirms one call.
// ---------------------------------------------------------------------------

/** The masthead rail's lanes, as `label -> the number (or word) beside it`. */
const crailOf = (byId) => Object.fromEntries(byId.get('crail').querySelectorAll('.crlane')
  .map((n) => [n.textContent.replace(/\s*[\d,~— ]*$/, '').trim(), n.children[0].textContent]));

test('the masthead rail carries a screens lane, and says shipped, degraded and not shipped differently', async (t) => {
  const { ctx, byId } = await bootPage(t, { ids: ['delta'], hash: '#p=delta&tab=overview' });

  // SHIPPED: the count is the overview's own screens block, at the LEFT end of
  // the rail — the chain starts in the browser.
  assert.equal(ev(ctx, 'OV.resp.answer.screens.screens'), 2);
  const lanes = byId.get('crail').querySelectorAll('.crlane');
  assert.equal(lanes[0].children[0].textContent, '2', 'the screens lane leads the rail');
  assert.equal(crailOf(byId).screens, '2');
  assert.equal(lanes[0].classList.contains('hollow'), false);
  assert.equal(lanes[0].title, '');

  // DEGRADED: the number stands, with a mark saying it is a lower bound and the
  // ENGINE's own reason on it.
  ev(ctx, `OV.resp.answer.axes.screen = { status:'degraded', reason:'the router is filled in by the server' };
    renderCascadeRail();`);
  const deg = byId.get('crail').querySelectorAll('.crlane')[0];
  assert.equal(deg.children[0].textContent, '2 ~');
  assert.equal(deg.title, 'the router is filled in by the server');
  assert.equal(deg.classList.contains('hollow'), false, 'a degraded axis still has a number');

  // NOT SHIPPED: the word, hollow, with the reason as the title — the same
  // treatment every other not-shipped lane gets.
  ev(ctx, `OV.resp.answer.axes.screen = { status:'not-shipped', reason:'the profile turns the screen axis off' };
    renderCascadeRail();`);
  const off = byId.get('crail').querySelectorAll('.crlane')[0];
  assert.equal(off.children[0].textContent, 'not shipped');
  assert.equal(off.classList.contains('hollow'), true);
  assert.equal(off.title, 'the profile turns the screen axis off');
});

test('a pack with no frontend has no screens lane number to show, and says so', async (t) => {
  const { byId } = await bootPage(t, { ids: ['gamma'], hash: '#p=gamma&tab=overview' });
  const lane = byId.get('crail').querySelectorAll('.crlane')[0];
  assert.equal(lane.children[0].textContent, 'not shipped');
  assert.equal(lane.classList.contains('hollow'), true);
  assert.match(lane.title, /analysed without the part that counts these/);
});

test('the Overview grows a fifth dial and a screens list, both from an answer', async (t) => {
  const { ctx, byId, calls } = await bootPage(t, { ids: ['delta'], hash: '#p=delta&tab=overview' });

  // The dial is `reachingATable / screens`, field for field.
  const got = JSON.parse(ev(ctx, `(() => {
    const a = OV.resp.answer;
    const k = OV_KPI.find((x) => x.kind === 'screen');
    return JSON.stringify({ got: k.got(a), of: k.of(a), block: a.screens });
  })()`));
  assert.deepEqual([got.got, got.of], [got.block.reachingATable, got.block.screens]);
  const dens = byId.get('ovcards').querySelectorAll('.kpiden').map((x) => x.textContent);
  assert.equal(dens.length, 5, 'four backend lanes and the screens');
  assert.ok(dens[4].startsWith(`${got.got} / ${got.of}`), dens[4]);
  assert.equal(byId.get('ovcards').querySelectorAll('.kpinote').length, 0,
    'this router is not server-driven, so nothing claims it is');

  // …and it says so when the router IS filled in by the server.
  ev(ctx, 'OV.resp.answer.screens.serverDriven = true; renderOverview();');
  await settle(ctx, 4);
  assert.match(byId.get('ovcards').querySelectorAll('.kpinote')[0].textContent, /fills this router in at run time/);

  // The three blind spots a screen axis brings with it are chips like every
  // other — this pack's recording is one of them. The chip reads the plain
  // label (RM36) and the engine's own kind is on its tooltip beside the count.
  ev(ctx, 'OV.resp.answer.screens.serverDriven = false; renderOverview();');
  await settle(ctx, 4);
  const gaps = JSON.parse(ev(ctx, 'JSON.stringify(OV.resp.answer.gaps.map((g)=>g.kind))'));
  assert.ok(gaps.includes('screens-seen-at-run-time'), gaps.join(', '));
  const gapChips = byId.get('ovherocol').querySelectorAll('.ovchip').map((c) => c.textContent);
  assert.ok(gapChips.some((c) => c.includes(VIEWER_STRINGS.en['ov.gap.screens-seen-at-run-time.label'])),
    gapChips.join(' | '));
  assert.ok(byId.get('ovherocol').querySelectorAll('button.foldlead.ovchip')
    .some((c) => c.title.includes('screens-seen-at-run-time')), 'the engine kind left the tooltip');

  // The list is ONE browse request, and a click walks the chain from that screen.
  const browses = toolCalls(calls, 'browse').filter((c) => c.args.kind === 'screen');
  assert.deepEqual(browses, [{ name: 'browse', args: { kind: 'screen', sort: 'tables', limit: 5 } }]);
  const panel = byId.get('ovpanels').querySelectorAll('.panel')
    .find((x) => x.textContent.includes('Screens, by how many tables they reach'));
  assert.ok(panel, 'the panel is on the tab');
  const rows = panel.querySelectorAll('td.wrapcell a');
  assert.deepEqual(rows.map((a) => a.textContent), ['/rows', '/quiet']);
  rows[0].onclick();
  await settle(ctx, 12);
  assert.equal(ev(ctx, 'STATE.tab'), 'flow');
  assert.equal(byId.get('fentry').value, '/rows');
  assert.deepEqual(toolCalls(calls, 'flow').filter((c) => c.args.screen).map((c) => c.args.screen), ['/rows']);
});

test('a pack with no frontend draws no screens list: the section says why, in one line', async (t) => {
  const { byId, calls } = await bootPage(t, { ids: ['gamma'], hash: '#p=gamma&tab=overview' });
  assert.deepEqual(toolCalls(calls, 'browse').filter((c) => c.args.kind === 'screen'), [],
    'nothing to list means nothing is asked for');
  const panel = byId.get('ovpanels').querySelectorAll('.panel')
    .find((x) => x.textContent.includes('Screens, by how many tables they reach'));
  assert.ok(panel);
  assert.match(panel.textContent, /analysed without a frontend/);
});

test('Explore lists screens from ONE browse request, and a pick opens the screen card', async (t) => {
  const { ctx, byId, calls } = await bootPage(t, { ids: ['delta'], hash: '#p=delta&tab=explore' });
  assert.equal(byId.get('exkinds').children.map((b) => b.textContent).join('|'),
    'Tables1|Columns2|Statements2|Endpoints2|Methods|Screens2');

  calls.length = 0;
  byId.get('exkinds').children[5].onclick();
  await settle(ctx, 12);
  assert.deepEqual(toolCalls(calls, 'browse'),
    [{ name: 'browse', args: { kind: 'screen', limit: 200, sort: 'endpoints' } }]);
  const rows = rowsOf(byId, 'exlist');
  assert.deepEqual(rows.map((r) => r.title), ['/rows', '/quiet']);
  // The row: the label, the title under it, `api` / `tbl` and the `seen` mark.
  assert.deepEqual(rows[0].querySelectorAll('.brstat').map((x) => x.textContent), ['api2', 'tbl1']);
  assert.deepEqual(rows[0].querySelectorAll('.brflag').map((x) => x.textContent), ['seen']);
  assert.equal(rows[0].querySelector('.brsub').textContent, 'Rows');
  assert.deepEqual(rows[1].querySelectorAll('.brflag').map((x) => x.textContent), [],
    'the screen no recording saw carries no mark');

  // A pick is one `flow screen=` request, and the card is drawn from it.
  calls.length = 0;
  rows[0].onclick();
  await settle(ctx, 16);
  assert.deepEqual(toolCalls(calls, 'flow'),
    [{ name: 'flow', args: { screen: '/rows', depth: 8, limit: 200 } }]);
  const card = byId.get('view').textContent;
  assert.match(card, /src\/views\/rows\.vue/, 'the component the route mounts');
  assert.match(card, /what this screen runs/);
  assert.match(card, /API routes it reaches/);
  assert.match(card, /tables at the end/);
  assert.match(card, /nothing above it to ask about/, 'and why Impact is not offered');
  assert.equal(ev(ctx, 'location.hash'), '#p=delta&tab=explore&pick=screen%3A%2Frows');
  // The function that SENDS is the one the endpoint rows hang off; the one that
  // only calls it leads to the request.
  const fns = byId.get('view').querySelectorAll('.panel')
    .find((x) => x.textContent.includes('what this screen runs'));
  assert.deepEqual(fns.querySelectorAll('li .tag').map((x) => x.textContent),
    ['leads to', 'sends', 'sends']);
});

test('Flow lists either end of the round trip, and remembers which one per project', async (t) => {
  const { ctx, byId, calls, store } = await bootPage(t, { ids: ['delta'], hash: '#p=delta&tab=flow' });
  assert.deepEqual(byId.get('fkinds').children.map((b) => b.textContent), ['Endpoints2', 'Screens2']);
  assert.deepEqual(rowsOf(byId, 'flist').map((r) => r.title), ['GET /rows', 'POST /rows/save']);

  calls.length = 0;
  byId.get('fkinds').children[1].onclick();
  await settle(ctx, 12);
  assert.deepEqual(toolCalls(calls, 'browse'),
    [{ name: 'browse', args: { kind: 'screen', limit: 200, sort: 'endpoints' } }]);
  // The screens are bucketed under their own group, with the group's counts.
  assert.deepEqual(byId.get('flist').querySelectorAll('.brgname').map((g) => g.textContent),
    ['▾ rows', '▾ quiet']);
  assert.deepEqual(byId.get('flist').querySelectorAll('.brgn').map((g) => g.textContent),
    ['1 screens', '1 reach an API', '1 screens', '0 reach an API']);
  assert.equal(store.get('cascade.viewer.flowkind.delta'), 'screen');

  // A pick draws `flow screen=`.
  calls.length = 0;
  rowsOf(byId, 'flist')[0].onclick();
  await settle(ctx, 16);
  assert.deepEqual(toolCalls(calls, 'flow').map((c) => c.args.screen), ['/rows']);

  // …and the next visit to this project opens on the end the reader left it on.
  const again = await bootPage(t, { ids: ['delta'], hash: '#p=delta&tab=flow',
    storage: { 'cascade.viewer.flowkind.delta': 'screen' } });
  assert.equal(ev(again.ctx, 'RAIL.flow.kind'), 'screen');
  assert.deepEqual(toolCalls(again.calls, 'browse').filter((c) => c.args.kind === 'endpoint'), [],
    'and it does not ask for the list it is not showing');
});

test('a pack with no frontend is offered no Flow kind switch at all', async (t) => {
  const { byId } = await bootPage(t, { ids: ['gamma'], hash: '#p=gamma&tab=flow' });
  assert.equal(byId.get('fkinds').classList.contains('hidden'), true);
  assert.equal(byId.get('fkinds').children.length, 0);
});

test('down from a screen the chain draws six lanes, entry first', async (t) => {
  const { ctx, byId } = await bootPage(t, { ids: ['delta'], hash: '#p=delta&tab=flow' });
  ev(ctx, "openFlow({screen:'/rows'})");
  await settle(ctx, 20);

  // The control was raised to the depth a screen needs, in the open, and the
  // request carried the number the control shows.
  assert.equal(byId.get('fdepth').value, '8');
  assert.equal(ev(ctx, 'FLOWV.resp.answer.walk.depth'), 8);

  const cols = byId.get('flowwrap').querySelectorAll('.fcoltitle').map((x) => x.textContent);
  assert.deepEqual(cols, ['entry', 'frontend function', 'endpoint', 'service layer', 'mapper statement', 'table']);
  const rows = byId.get('flowwrap').querySelectorAll('.frow');
  assert.ok(rows.length >= 9, `the six lanes really hold rows: ${rows.length}`);
  const names = byId.get('flowwrap').querySelectorAll('.fname').map((x) => x.textContent);
  assert.ok(names.includes('rows.vue#getList'), names.join(', '));
  assert.ok(names.includes('GET /rows'), names.join(', '));
  assert.ok(names.includes('delta_rows'), names.join(', '));

  // A frontend row says which kind of function it is, and the route rows carry
  // the two facts only a pack with a frontend has.
  const wrapText = byId.get('flowwrap').textContent;
  assert.match(wrapText, /component/);
  assert.match(wrapText, /web 1/, 'how many frontend functions call the route');
  assert.match(wrapText, /seen/, 'and that a recording confirms one of them');
});

test('up from a column the chain closes with the frontend function and the screen', async (t) => {
  const { ctx, byId } = await bootPage(t, { ids: ['delta'], hash: '#p=delta&tab=impact' });
  ev(ctx, "openImpact({column:'delta_rows.status'})");
  await settle(ctx, 20);
  const cols = byId.get('impactwrap').querySelectorAll('.fcoltitle').map((x) => x.textContent);
  assert.deepEqual(cols, ['target', 'mapper statement', 'service layer', 'endpoint', 'frontend function', 'screen']);
  const names = byId.get('impactwrap').querySelectorAll('.fname').map((x) => x.textContent);
  assert.ok(names.includes('/rows'), names.join(', '));
  assert.ok(names.includes('rows.js#listRows'), names.join(', '));

  // The by-hop view ENDS on the screens, not on the routes, because that is the
  // last lane this answer has.
  assert.equal(ev(ctx, "chainEndField(IMPACTV, IMPACTV.resp.answer)"), 'screens');
  ev(ctx, "document.querySelectorAll('#iview button')[1].onclick()");
  await settle(ctx, 8);
  assert.match(byId.get('impactwrap').textContent, /end of the chain: screens|screens/);
  ev(ctx, "document.querySelectorAll('#iview button')[0].onclick()");
  await settle(ctx, 8);

  // A language switch re-renders the new headings out of the catalogue alone.
  ev(ctx, "setLang('ko')");
  await settle(ctx, 8);
  const ko = byId.get('impactwrap').querySelectorAll('.fcoltitle').map((x) => x.textContent);
  assert.equal(ko[4], '프런트엔드 함수');
  assert.equal(ko[5], '화면');
});

test('the source pane opens a frontend function and a screen component', async (t) => {
  const { ctx, byId } = await bootPage(t, { ids: ['delta'], hash: '#p=delta&tab=explore' });

  // A frontend function: its own extent, by brace balance, in real file lines.
  ev(ctx, "srcOpen('symbol:src/api/rows.js#listRows', {tab:'explore'})");
  await settle(ctx, 12);
  const fn = JSON.parse(ev(ctx, 'JSON.stringify(SRC.resp)'));
  assert.equal(fn.ok, true);
  assert.equal(fn.file, 'src/api/rows.js');
  assert.equal(fn.lang, 'js');
  assert.deepEqual([fn.from, fn.to], [3, 9]);
  assert.match(fn.snippet, /^export function listRows/);

  // A screen: the WHOLE component, with the line its script opens on marked.
  ev(ctx, "srcOpen('screen:/rows', {tab:'explore'})");
  await settle(ctx, 12);
  const scr = JSON.parse(ev(ctx, 'JSON.stringify(SRC.resp)'));
  assert.equal(scr.file, 'src/views/rows.vue');
  assert.equal(scr.lang, 'js', 'the script block declares no lang, so it is JavaScript');
  assert.deepEqual([scr.from, scr.to, scr.mark], [1, 15, 5]);
  assert.match(scr.snippet, /^<template>/);
  // Exactly one line is lit — the mark — and the path copies THAT line.
  const lit = byId.get('srcbody').querySelectorAll('.srcln.hi');
  assert.equal(lit.length, 1);
  assert.match(lit[0].textContent, /<script>/);
  assert.equal(byId.get('srchd').querySelector('.srcpath').textContent, 'src/views/rows.vue:5');
});

test('the Graph tab draws a screens layer: the chip, its default, and the screen colour', async (t) => {
  // With a stand-in renderer, so the model the page builds out of the answer
  // really runs. The canvas is still nobody's test here.
  const { ctx, byId, calls, html } = await bootPage(t, { ids: ['delta'], hash: '#p=delta&tab=graph', renderer: true });
  await settle(ctx, 20);

  // Two screens is well under the cap, so the layer is on and the map was asked
  // for WITH it. (The very first request can be the one that ran before the
  // overview answered; what matters is that the answer on screen carries it.)
  assert.equal(ev(ctx, 'GMAP.screens'), true);
  assert.equal(ev(ctx, 'GMAP.resp.answer.layers.screens'), true);
  assert.ok(toolCalls(calls, 'map').some((c) => (c.args.layers || []).includes('screens')));

  // The picture holds the screen that reaches a route, and not the one that
  // reaches none: a dot with no line would say "this screen calls nothing".
  assert.deepEqual(ev(ctx, "JSON.stringify(GMAP.nodes.filter(n=>n.kind==='screen').map(n=>n.id))"),
    '["screen:/rows"]');
  assert.equal(ev(ctx, 'GMAP.resp.answer.summary.screens'), 1);
  assert.equal(ev(ctx, 'GMAP.resp.answer.summary.screensTotal'), 2);
  // …drawn in the screen token's own colour, out of the theme on <html>.
  assert.equal(ev(ctx, "GMAP.nodes.find(n=>n.kind==='screen').fill"),
    themeTokens(html, 'signal')['--n-screen']);

  // The chip says what the layer is doing, and turning it off RE-ASKS without it.
  const chips = byId.get('gchips').querySelectorAll('button').map((b) => b.textContent);
  assert.ok(chips.some((c) => /screens on \(1\)/.test(c)), chips.join(' | '));
  calls.length = 0;
  byId.get('gchips').querySelectorAll('button').find((b) => /screens on/.test(b.textContent)).onclick();
  await settle(ctx, 16);
  assert.equal(ev(ctx, 'GMAP.screens'), false);
  assert.deepEqual(toolCalls(calls, 'map').map((c) => c.args.layers || null), [null]);
  assert.equal(ev(ctx, "GMAP.nodes.filter(n=>n.kind==='screen').length"), 0);
});
