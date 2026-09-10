import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { handleApi, handleI18n, handleVendor, serveHttp } from '../src/mcp/http.mjs';
import { createProjectHost } from '../src/mcp/projects.mjs';
import { buildGraphFromSql } from '../src/adapters/sql_bridge.mjs';
import { callTool as catalogCallTool, toolList as catalogToolList } from '../src/mcp/catalog.mjs';
import { assertContract } from '../src/mcp/contract.mjs';

// ---------------------------------------------------------------------------
// Fixture — stub deps. handleApi only needs the shape {toolList, callTool,
// meta}; the real ones live in src/mcp/catalog.mjs but a stub makes the
// routing/status-mapping assertions precise (see test/stdio.test.mjs for the
// same pattern with handleRpc).
// ---------------------------------------------------------------------------

const TOOL_LIST_RESULT = { schema: 'x', tools: [{ name: 'column_impact', description: 'd', inputSchema: {} }] };
const META_RESULT = { project: 'p' };
const CALL_RESULT = { answer: { column: 'pms_product.price' }, trust: { trustLevel: 'UNCERTIFIED' } };

function makeDeps(overrides = {}) {
  return {
    toolList: () => TOOL_LIST_RESULT,
    meta: () => META_RESULT,
    callTool: () => CALL_RESULT,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// GET /api/source
// ---------------------------------------------------------------------------

const SOURCE_RESULT = { kind: 'statement', ok: true, file: 'm.xml', lang: 'xml', snippet: '<select id="a">SQL_A</select>' };

test('GET /api/source: 200, json is deps.source(node); deps.source receives the node id', () => {
  let seenNode;
  const deps = makeDeps({ source: (node) => { seenNode = node; return SOURCE_RESULT; } });
  const query = new URLSearchParams({ node: 'statement:ns.a' });
  const resp = handleApi('GET', '/api/source', null, deps, query);
  assert.equal(resp.status, 200);
  assert.deepEqual(resp.json, SOURCE_RESULT);
  assert.equal(seenNode, 'statement:ns.a');
});

test('GET /api/source: works with a plain {get} stub in place of URLSearchParams', () => {
  let seenNode;
  const deps = makeDeps({ source: (node) => { seenNode = node; return SOURCE_RESULT; } });
  const query = { get: (k) => (k === 'node' ? 'table:pms_product' : null) };
  const resp = handleApi('GET', '/api/source', null, deps, query);
  assert.equal(resp.status, 200);
  assert.equal(seenNode, 'table:pms_product');
});

test('GET /api/source: missing node param -> 400 bad-request', () => {
  const deps = makeDeps({ source: () => SOURCE_RESULT });
  const query = new URLSearchParams({});
  const resp = handleApi('GET', '/api/source', null, deps, query);
  assert.equal(resp.status, 400);
  assert.equal(resp.json.error.code, 'bad-request');
});

test('GET /api/source: no query object at all -> 400 bad-request', () => {
  const deps = makeDeps({ source: () => SOURCE_RESULT });
  const resp = handleApi('GET', '/api/source', null, deps);
  assert.equal(resp.status, 400);
  assert.equal(resp.json.error.code, 'bad-request');
});

test('GET /api/source: deps without a source() function -> 404 not-found', () => {
  const deps = makeDeps(); // no `source` override — default fixture has none
  const query = new URLSearchParams({ node: 'statement:ns.a' });
  const resp = handleApi('GET', '/api/source', null, deps, query);
  assert.equal(resp.status, 404);
  assert.equal(resp.json.error.code, 'not-found');
});

test('GET /api/source: deps.source throws -> 500 source-error', () => {
  const deps = makeDeps({ source: () => { throw new Error('read failed'); } });
  const query = new URLSearchParams({ node: 'statement:ns.a' });
  const resp = handleApi('GET', '/api/source', null, deps, query);
  assert.equal(resp.status, 500);
  assert.deepEqual(resp.json, { error: { code: 'source-error', message: 'read failed' } });
});

test('POST /api/source: 405 method-not-allowed', () => {
  const deps = makeDeps({ source: () => SOURCE_RESULT });
  const query = new URLSearchParams({ node: 'statement:ns.a' });
  const resp = handleApi('POST', '/api/source', null, deps, query);
  assert.equal(resp.status, 405);
  assert.equal(resp.json.error.code, 'method-not-allowed');
});

// ---------------------------------------------------------------------------
// GET /api/meta
// ---------------------------------------------------------------------------

test('GET /api/meta: 200, json is deps.meta()', () => {
  const resp = handleApi('GET', '/api/meta', null, makeDeps());
  assert.equal(resp.status, 200);
  assert.deepEqual(resp.json, META_RESULT);
});

test('GET /api/meta: deps without a meta() falls back to 200 {}', () => {
  const deps = makeDeps();
  delete deps.meta;
  const resp = handleApi('GET', '/api/meta', null, deps);
  assert.equal(resp.status, 200);
  assert.deepEqual(resp.json, {});
});

test('POST /api/meta: 405 method-not-allowed', () => {
  const resp = handleApi('POST', '/api/meta', null, makeDeps());
  assert.equal(resp.status, 405);
  assert.equal(resp.json.error.code, 'method-not-allowed');
});

// ---------------------------------------------------------------------------
// GET /api/tools
// ---------------------------------------------------------------------------

test('GET /api/tools: 200, json is deps.toolList()', () => {
  const resp = handleApi('GET', '/api/tools', null, makeDeps());
  assert.equal(resp.status, 200);
  assert.deepEqual(resp.json, TOOL_LIST_RESULT);
});

test('POST /api/tools: 405 method-not-allowed', () => {
  const resp = handleApi('POST', '/api/tools', null, makeDeps());
  assert.equal(resp.status, 405);
  assert.equal(resp.json.error.code, 'method-not-allowed');
});

// ---------------------------------------------------------------------------
// POST /api/call — method gate
// ---------------------------------------------------------------------------

test('GET /api/call: 405 method-not-allowed', () => {
  const resp = handleApi('GET', '/api/call', null, makeDeps());
  assert.equal(resp.status, 405);
  assert.equal(resp.json.error.code, 'method-not-allowed');
});

// ---------------------------------------------------------------------------
// POST /api/call — success path
// ---------------------------------------------------------------------------

test('POST /api/call success: 200, json is exactly what callTool returned; callTool receives name + arguments', () => {
  let seenName, seenArgs;
  const deps = makeDeps({
    callTool: (name, args) => { seenName = name; seenArgs = args; return CALL_RESULT; },
  });
  const body = { name: 'column_impact', arguments: { column: 'pms_product.price' } };
  const resp = handleApi('POST', '/api/call', body, deps);
  assert.equal(resp.status, 200);
  assert.deepEqual(resp.json, CALL_RESULT);
  assert.equal(seenName, 'column_impact');
  assert.deepEqual(seenArgs, { column: 'pms_product.price' });
});

test('POST /api/call with arguments omitted: callTool receives {} as arguments', () => {
  let seenArgs = 'not-called';
  const deps = makeDeps({
    callTool: (name, args) => { seenArgs = args; return CALL_RESULT; },
  });
  const resp = handleApi('POST', '/api/call', { name: 'column_impact' }, deps);
  assert.equal(resp.status, 200);
  assert.deepEqual(seenArgs, {});
});

// ---------------------------------------------------------------------------
// POST /api/call — error code -> status mapping
// ---------------------------------------------------------------------------

const CODE_STATUS_CASES = [
  ['unknown-tool', 400],
  ['bad-input', 400],
  ['unknown-column', 404],
  ['contract-violation', 500],
];

for (const [code, expectedStatus] of CODE_STATUS_CASES) {
  test(`POST /api/call: thrown error with code ${code} -> ${expectedStatus}`, () => {
    const deps = makeDeps({
      callTool: () => { throw Object.assign(new Error(`boom-${code}`), { code }); },
    });
    const resp = handleApi('POST', '/api/call', { name: 'x' }, deps);
    assert.equal(resp.status, expectedStatus);
    assert.deepEqual(resp.json, { error: { code, message: `boom-${code}` } });
  });
}

test('POST /api/call: thrown error with NO code -> 500, code "error"', () => {
  const deps = makeDeps({
    callTool: () => { throw new Error('no code here'); },
  });
  const resp = handleApi('POST', '/api/call', { name: 'x' }, deps);
  assert.equal(resp.status, 500);
  assert.deepEqual(resp.json, { error: { code: 'error', message: 'no code here' } });
});

// ---------------------------------------------------------------------------
// POST /api/call — bad request bodies
// ---------------------------------------------------------------------------

test('POST /api/call: body {} (missing name) -> 400 bad-request', () => {
  const resp = handleApi('POST', '/api/call', {}, makeDeps());
  assert.equal(resp.status, 400);
  assert.equal(resp.json.error.code, 'bad-request');
});

test('POST /api/call: body null -> 400 bad-request', () => {
  const resp = handleApi('POST', '/api/call', null, makeDeps());
  assert.equal(resp.status, 400);
  assert.equal(resp.json.error.code, 'bad-request');
});

test('POST /api/call: body { name: "" } (blank name) -> 400 bad-request', () => {
  const resp = handleApi('POST', '/api/call', { name: '' }, makeDeps());
  assert.equal(resp.status, 400);
  assert.equal(resp.json.error.code, 'bad-request');
});

test('POST /api/call: name not a string -> 400 bad-request', () => {
  const resp = handleApi('POST', '/api/call', { name: 42 }, makeDeps());
  assert.equal(resp.status, 400);
  assert.equal(resp.json.error.code, 'bad-request');
});

test('POST /api/call: non-object body (a string) -> 400 bad-request', () => {
  const resp = handleApi('POST', '/api/call', 'not-an-object', makeDeps());
  assert.equal(resp.status, 400);
  assert.equal(resp.json.error.code, 'bad-request');
});

// ---------------------------------------------------------------------------
// Unknown path
// ---------------------------------------------------------------------------

test('GET /nope: 404 not-found', () => {
  const resp = handleApi('GET', '/nope', null, makeDeps());
  assert.equal(resp.status, 404);
  assert.equal(resp.json.error.code, 'not-found');
});

test('POST /nope: 404 not-found (path check precedes method for unknown routes)', () => {
  const resp = handleApi('POST', '/nope', null, makeDeps());
  assert.equal(resp.status, 404);
  assert.equal(resp.json.error.code, 'not-found');
});

// ---------------------------------------------------------------------------
// Real catalog integration — confirms a real contract-valid response passes
// through handleApi unchanged (same fixture shape as test/catalog.test.mjs).
// ---------------------------------------------------------------------------

function catalogRecords() {
  return [
    { kind: 'table', schema: null, table: 'pms_product', comment: 'product catalog table' },
    { kind: 'column', schema: null, table: 'pms_product', column: 'id', type: 'INT', comment: 'primary key' },
    { kind: 'column', schema: null, table: 'pms_product', column: 'price', type: 'DECIMAL(10,2)', comment: 'unit price' },
  ];
}

function lineageRecords() {
  return [
    {
      kind: 'lineage', namespace: 'PmsProductMapper', id: 'selectByPrimaryKey', type: 'select',
      tables: [{ table: 'pms_product', access: 'read' }],
      columns: [
        { table: 'pms_product', column: 'id', access: 'read' },
        { table: 'pms_product', column: 'price', access: 'read' },
      ],
      file: 'PmsProductMapper.xml', line: 30,
    },
  ];
}

test('POST /api/call with the real catalog callTool: 200, response satisfies the tool-result contract', () => {
  const graph = buildGraphFromSql(catalogRecords(), lineageRecords());
  const ctx = { graph, basis: { project: 't', buildDigest: 'd', builtAt: 'x', freshness: { verdict: 'unknown' } }, trust: { trustLevel: 'UNCERTIFIED' } };
  const deps = {
    toolList: catalogToolList,
    callTool: (name, args) => catalogCallTool(name, args, ctx),
  };
  const resp = handleApi('POST', '/api/call', { name: 'column_impact', arguments: { column: 'pms_product.price' } }, deps);
  assert.equal(resp.status, 200);
  assert.doesNotThrow(() => assertContract(resp.json));
  assert.equal(resp.json.answer.column, 'pms_product.price');
});

test('POST /api/call with the real catalog callTool: an unknown column -> 404 unknown-column', () => {
  const graph = buildGraphFromSql(catalogRecords(), lineageRecords());
  const ctx = { graph, basis: { project: 't', buildDigest: 'd', builtAt: 'x', freshness: { verdict: 'unknown' } }, trust: { trustLevel: 'UNCERTIFIED' } };
  const deps = {
    toolList: catalogToolList,
    callTool: (name, args) => catalogCallTool(name, args, ctx),
  };
  const resp = handleApi('POST', '/api/call', { name: 'column_impact', arguments: { column: 'pms_product.nope' } }, deps);
  assert.equal(resp.status, 404);
  assert.equal(resp.json.error.code, 'unknown-column');
});

// ---------------------------------------------------------------------------
// GET /api/projects — the registry listing, and `project` routing (SPEC §15 M8
// + M9). Two rules under test: listing NEVER loads a pack (so `meta` is null
// until that project has answered something), and a request that does not say
// which project it means is refused rather than guessed.
// ---------------------------------------------------------------------------

// Two projects over one host, backed by the real tool catalog: whatever the
// page sees here is what an AI sees over stdio.
function twoProjectHost() {
  const loaded = [];
  const ctxOf = (id, price) => ({
    graph: buildGraphFromSql(catalogRecords(), lineageRecords()),
    basis: { project: id, buildDigest: 'digest-' + id, builtAt: '2026-09-04T00:00:00.000Z', freshness: { verdict: 'unknown' } },
    trust: { trustLevel: 'UNCERTIFIED', axes: [] },
    limits: [],
    pack: { project: 'pack-' + id, digest: 'digest-' + id, builtAt: '2026-09-04T00:00:00.000Z', lanes: ['sql'], axes: { sql: true } },
    price,
  });
  const host = createProjectHost({
    registry: [{ id: 'alpha', dotCascadePath: '/tmp/alpha/.cascade' }, { id: 'beta', dotCascadePath: '/tmp/beta/.cascade' }],
    loadProject: (e) => { loaded.push(e.id); return ctxOf(e.id, e.id === 'alpha' ? 1 : 2); },
    measureBytes: () => 10,
  });
  return { host, loaded, deps: { toolList: catalogToolList, callTool: (n, a) => host.callTool(n, a) } };
}

test('GET /api/projects: the registry listing, with meta null until a project has been asked something', () => {
  const { deps, loaded } = twoProjectHost();
  const before = handleApi('GET', '/api/projects', null, deps);
  assert.equal(before.status, 200);
  assert.doesNotThrow(() => assertContract(before.json));
  assert.deepEqual(loaded, [], 'listing must not load a pack');
  assert.deepEqual(before.json.answer.projects.map((p) => p.id), ['alpha', 'beta']);
  assert.deepEqual(before.json.answer.projects.map((p) => p.loaded), [false, false]);
  assert.deepEqual(before.json.answer.projects.map((p) => p.meta), [null, null]);
  assert.equal(before.json.answer.cache.loaded, 0);

  // Ask ONE project a question; only that one is loaded, and only that one
  // gains a meta summary.
  const call = handleApi('POST', '/api/call', { name: 'column_impact', arguments: { column: 'pms_product.price' }, project: 'alpha' }, deps);
  assert.equal(call.status, 200);
  assert.deepEqual(loaded, ['alpha']);

  const after = handleApi('GET', '/api/projects', null, deps);
  const [alpha, beta] = after.json.answer.projects;
  assert.equal(alpha.loaded, true);
  assert.deepEqual(alpha.meta, {
    project: 'pack-alpha', digest: 'digest-alpha', builtAt: '2026-09-04T00:00:00.000Z',
    lanes: ['sql'], axes: { sql: true }, freshness: { verdict: 'unknown' },
  });
  assert.equal(beta.loaded, false);
  assert.equal(beta.meta, null, 'listing a loaded project must not load its neighbour');
  assert.equal(after.json.answer.cache.loaded, 1);
});

test('POST /api/projects: 405 method-not-allowed', () => {
  const { deps } = twoProjectHost();
  const r = handleApi('POST', '/api/projects', null, deps);
  assert.equal(r.status, 405);
  assert.equal(r.json.error.code, 'method-not-allowed');
});

test('POST /api/call on a multi-project server: no `project` -> 409 ambiguous JSON, never a guess', () => {
  const { deps, loaded } = twoProjectHost();
  const r = handleApi('POST', '/api/call', { name: 'column_impact', arguments: { column: 'pms_product.price' } }, deps);
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, 'ambiguous');
  assert.match(r.json.error.message, /alpha, beta/);
  assert.deepEqual(loaded, [], 'a refused call loads nothing');
});

test('POST /api/call: an unknown project -> 404 JSON', () => {
  const { deps } = twoProjectHost();
  const r = handleApi('POST', '/api/call', { name: 'column_impact', arguments: { column: 'pms_product.price' }, project: 'gamma' }, deps);
  assert.equal(r.status, 404);
  assert.equal(r.json.error.code, 'unknown-key');
  assert.match(r.json.error.message, /served ids are alpha, beta/);
});

test('`project` routes a tool call whether it rides in the body, in arguments, or in the query', () => {
  const seen = [];
  const deps = makeDeps({ callTool: (name, args) => { seen.push(args.project); return CALL_RESULT; } });
  handleApi('POST', '/api/call', { name: 'x', project: 'alpha' }, deps);
  handleApi('POST', '/api/call', { name: 'x', arguments: { project: 'beta' } }, deps);
  handleApi('POST', '/api/call', { name: 'x' }, deps, new URLSearchParams({ project: 'gamma' }));
  assert.deepEqual(seen, ['alpha', 'beta', 'gamma']);
});

test('GET /api/meta?project=<id> hands the id to deps.meta; a bad id comes back as JSON, not a blank pane', () => {
  const deps = makeDeps({
    meta: (project) => {
      if (project === 'alpha') return { project: 'alpha', digest: 'd-alpha' };
      if (!project) throw Object.assign(new Error('several projects are registered: alpha, beta — pass "project"'), { code: 'ambiguous' });
      throw Object.assign(new Error(`unknown project ${JSON.stringify(project)}`), { code: 'unknown-key' });
    },
  });
  const ok = handleApi('GET', '/api/meta', null, deps, new URLSearchParams({ project: 'alpha' }));
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { project: 'alpha', digest: 'd-alpha' });

  const unknown = handleApi('GET', '/api/meta', null, deps, new URLSearchParams({ project: 'gamma' }));
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.error.code, 'unknown-key');

  const ambiguous = handleApi('GET', '/api/meta', null, deps, new URLSearchParams());
  assert.equal(ambiguous.status, 409);
  assert.equal(ambiguous.json.error.code, 'ambiguous');
});

test('GET /api/source?project=<id> routes the preview to that project, and says so when the id is unknown', () => {
  const seen = [];
  const deps = makeDeps({
    source: (node, project) => {
      seen.push([node, project]);
      if (project === 'beta') throw Object.assign(new Error('unknown project "beta"'), { code: 'unknown-key' });
      return SOURCE_RESULT;
    },
  });
  const ok = handleApi('GET', '/api/source', null, deps, new URLSearchParams({ node: 'statement:ns.a', project: 'alpha' }));
  assert.equal(ok.status, 200);
  assert.deepEqual(seen[0], ['statement:ns.a', 'alpha']);

  const bad = handleApi('GET', '/api/source', null, deps, new URLSearchParams({ node: 'statement:ns.a', project: 'beta' }));
  assert.equal(bad.status, 404);
  assert.equal(bad.json.error.code, 'unknown-key');
});

test('GET /api/tools carries no project: the catalog is the SERVER\'s, not a pack\'s', () => {
  const { deps } = twoProjectHost();
  const r = handleApi('GET', '/api/tools', null, deps, new URLSearchParams({ project: 'gamma' }));
  assert.equal(r.status, 200, 'an unknown project cannot break the tool list');
  assert.ok(Array.isArray(r.json.tools));
});

// ---------------------------------------------------------------------------
// GET /i18n/<lang>.json — the translation catalogues (SPEC §17.11). The same
// shelf rule as /vendor: one directory, one extension, every escape a 404.
// ---------------------------------------------------------------------------

const I18N_DIR = fileURLToPath(new URL('../viewer/i18n', import.meta.url));

test('GET /i18n/ko.json: 200, JSON content type, and it really is the Korean catalogue', () => {
  const r = handleI18n('GET', '/i18n/ko.json', { i18nDir: I18N_DIR });
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'application/json; charset=utf-8');
  const parsed = JSON.parse(Buffer.from(r.body).toString('utf8'));
  assert.equal(typeof parsed['tab.overview'], 'string');
  assert.match(Buffer.from(r.body).toString('utf8'), /[\uac00-\ud7a3]/, 'the catalogue carries Hangul — that is what it is for');
});

test('GET /i18n/<escape>: every way out of the directory is a 404', () => {
  const deps = { i18nDir: I18N_DIR };
  for (const p of ['/i18n/../package.json', '/i18n/../../etc/passwd', '/i18n/%2e%2e/package.json',
    '/i18n//etc/passwd', '/i18n/', '/i18n/ko', '/i18n/ko.js', '/i18n/nope.json', '/i18n/%zz.json']) {
    const r = handleI18n('GET', p, deps);
    assert.equal(r.status, 404, `${p} must be refused`);
    assert.equal(r.body, 'not found', `${p} must not say whether the file exists`);
  }
});

test('handleI18n: no i18nDir, a wrong prefix, or a POST', () => {
  assert.equal(handleI18n('GET', '/i18n/ko.json', {}).status, 404);
  assert.equal(handleI18n('GET', '/vendor/ko.json', { i18nDir: I18N_DIR }).status, 404);
  assert.equal(handleI18n('POST', '/i18n/ko.json', { i18nDir: I18N_DIR }).status, 405);
});

test('handleI18n reads through an injected readFile — it never guesses a body', () => {
  const seen = [];
  const r = handleI18n('GET', '/i18n/xx.json', {
    i18nDir: '/tmp/i18n-probe',
    readFile: (abs) => { seen.push(abs); return '{}'; },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body, '{}');
  assert.deepEqual(seen, ['/tmp/i18n-probe/xx.json']);
});

// ---------------------------------------------------------------------------
// GET /vendor/<name> — the two vendored MIT browser bundles the Graph tab's map
// renderers load. A static shelf, not a file server: only .js/.txt/.md, only out
// of viewer/vendor, and every escape is a 404 (never a 403 — the route must not
// report whether the file it refused exists).
// ---------------------------------------------------------------------------

const VENDOR_DIR = fileURLToPath(new URL('../viewer/vendor', import.meta.url));

test('GET /vendor/force-graph.min.js: 200 with the real file, JS content type and a day of cache', () => {
  const r = handleVendor('GET', '/vendor/force-graph.min.js', { vendorDir: VENDOR_DIR });
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'application/javascript; charset=utf-8');
  assert.equal(r.headers['cache-control'], 'public, max-age=86400');
  const body = Buffer.from(r.body).toString('utf8');
  assert.match(body, /^\/\/ Version 1\.51\.4 force-graph/, 'the vendored UMD build, unmodified');
  assert.equal(Buffer.byteLength(r.body), nodeFs.statSync(VENDOR_DIR + '/force-graph.min.js').size, 'the whole file, byte for byte');
});

test('GET /vendor/3d-force-graph.min.js: 200, and it carries three r183 inside it', () => {
  const r = handleVendor('GET', '/vendor/3d-force-graph.min.js', { vendorDir: VENDOR_DIR });
  assert.equal(r.status, 200);
  const body = Buffer.from(r.body).toString('utf8');
  assert.match(body, /^\/\/ Version 1\.80\.0 3d-force-graph/);
  assert.match(body, /s="183"/, 'the bundled three revision — no separate three file is served');
});

test('GET /vendor/<licence>.txt and README.md: 200 as plain text', () => {
  for (const name of ['LICENSE-force-graph.txt', 'LICENSE-3d-force-graph.txt', 'README.md']) {
    const r = handleVendor('GET', '/vendor/' + name, { vendorDir: VENDOR_DIR });
    assert.equal(r.status, 200, name);
    assert.equal(r.headers['content-type'], 'text/plain; charset=utf-8', name);
  }
  assert.match(Buffer.from(handleVendor('GET', '/vendor/LICENSE-force-graph.txt', { vendorDir: VENDOR_DIR }).body).toString('utf8'), /^MIT License/);
});

test('GET /vendor/fonts/<face>.woff2: 200, font/woff2, and a YEAR of immutable cache', () => {
  // A font file never changes under its own name — the name carries the family,
  // the weight and the subset — so it is cached for a year where the two
  // bundles get a day. The bytes are the real vendored face: `wOF2`.
  for (const name of ['IBM-Plex-Sans-latin.woff2', 'IBM-Plex-Mono-400-latin.woff2', 'IBM-Plex-Mono-500-latin.woff2']) {
    const r = handleVendor('GET', '/vendor/fonts/' + name, { vendorDir: VENDOR_DIR });
    assert.equal(r.status, 200, name);
    assert.equal(r.headers['content-type'], 'font/woff2', name);
    assert.equal(r.headers['cache-control'], 'public, max-age=31536000, immutable', name);
    assert.equal(Buffer.from(r.body).subarray(0, 4).toString('latin1'), 'wOF2', name);
    assert.equal(Buffer.byteLength(r.body), nodeFs.statSync(VENDOR_DIR + '/fonts/' + name).size, name);
  }
  // ...and the licence beside them is served as plain text, on the day cache.
  const lic = handleVendor('GET', '/vendor/fonts/OFL-IBM-Plex.txt', { vendorDir: VENDOR_DIR });
  assert.equal(lic.status, 200);
  assert.equal(lic.headers['content-type'], 'text/plain; charset=utf-8');
  assert.equal(lic.headers['cache-control'], 'public, max-age=86400');
});

test('GET /vendor/<missing>: 404', () => {
  const r = handleVendor('GET', '/vendor/not-here.js', { vendorDir: VENDOR_DIR });
  assert.equal(r.status, 404);
  assert.equal(r.body, 'not found');
});

test('GET /vendor: an extension the shelf does not serve is 404, not a directory listing', () => {
  for (const p of ['/vendor/', '/vendor/force-graph.min', '/vendor/package.json', '/vendor/x.html', '/vendor/x.wasm']) {
    assert.equal(handleVendor('GET', p, { vendorDir: VENDOR_DIR }).status, 404, p);
  }
});

test('GET /vendor: path traversal is refused — plain, encoded, nested and absolute', () => {
  const escapes = [
    '/vendor/../package.json',
    '/vendor/%2e%2e/package.json',
    '/vendor/%2E%2E%2Fpackage.json',
    '/vendor/a/../../package.json',
    '/vendor/..%2f..%2fpackage.json',
    '/vendor//etc/passwd.txt',
    '/vendor/' + encodeURIComponent('/etc/passwd') + '.txt',
    '/vendor/%ZZ.js', // a malformed escape names no file
  ];
  for (const p of escapes) {
    const r = handleVendor('GET', p, { vendorDir: VENDOR_DIR });
    assert.equal(r.status, 404, p);
    assert.equal(r.body, 'not found', p);
  }
  // …and the file those escapes were reaching for really is there to be taken
  assert.ok(nodeFs.existsSync(fileURLToPath(new URL('../package.json', import.meta.url))));
});

test('POST /vendor/force-graph.min.js: 405 method-not-allowed', () => {
  const r = handleVendor('POST', '/vendor/force-graph.min.js', { vendorDir: VENDOR_DIR });
  assert.equal(r.status, 405);
});

test('GET /vendor with no vendorDir in deps: 404 (a server that vendors nothing serves nothing)', () => {
  assert.equal(handleVendor('GET', '/vendor/force-graph.min.js', {}).status, 404);
  assert.equal(handleVendor('GET', '/vendor/force-graph.min.js', makeDeps()).status, 404);
});

test('handleVendor reads through an injected readFile — it never guesses a body', () => {
  const seen = [];
  const r = handleVendor('GET', '/vendor/anything.js', {
    vendorDir: '/tmp/vendor-probe',
    readFile: (abs) => { seen.push(abs); return 'BODY'; },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body, 'BODY');
  assert.deepEqual(seen, ['/tmp/vendor-probe/anything.js']);
});

test('/vendor is NOT an /api route: handleApi still 404s it, and /api/* is unchanged', () => {
  assert.equal(handleApi('GET', '/vendor/force-graph.min.js', null, makeDeps()).status, 404);
  assert.equal(handleApi('GET', '/api/tools', null, makeDeps()).status, 200);
  assert.equal(handleApi('POST', '/api/call', { name: 'column_impact' }, makeDeps()).status, 200);
  assert.equal(handleApi('GET', '/api/meta', null, makeDeps()).status, 200);
});

// ---------------------------------------------------------------------------
// serveHttp — the routing loop, driven through an INJECTED http module (the
// same trick the tools use for `readFile`): no sockets, so the assertion is
// about the routes and nothing else. / still serves the page, /vendor/* the
// bundle, /api/* the tools, and anything else 404s.
// ---------------------------------------------------------------------------

// A stand-in for node:http that keeps the request handler instead of listening,
// plus a `call(method, url)` that drives it with a minimal req/res pair.
function fakeHttp() {
  let handler = null;
  const module = {
    createServer(h) { handler = h; return { listen: (port, host, cb) => cb() }; },
  };
  const call = (method, url) => new Promise((resolve) => {
    const req = { method, url, setEncoding() {}, on(ev, cb) { if (ev === 'end') cb(); } };
    const res = {
      writeHead(status, headers) { this.status = status; this.headers = headers || {}; },
      end(body) { resolve({ status: this.status, headers: this.headers, body }); },
    };
    handler(req, res);
  });
  return { module, call };
}

test('serveHttp: /, /vendor/<file>, /api/tools and an unknown path, through an injected http module', async () => {
  const fake = fakeHttp();
  await serveHttp({
    http: fake.module, port: 0, deps: { ...makeDeps(), vendorDir: VENDOR_DIR }, html: '<!doctype html><title>page</title>',
  });

  const page = await fake.call('GET', '/');
  assert.equal(page.status, 200);
  assert.equal(page.headers['content-type'], 'text/html; charset=utf-8');
  assert.match(page.body, /<title>page<\/title>/);

  const bundle = await fake.call('GET', '/vendor/force-graph.min.js');
  assert.equal(bundle.status, 200);
  assert.equal(bundle.headers['content-type'], 'application/javascript; charset=utf-8');
  assert.equal(bundle.headers['cache-control'], 'public, max-age=86400');
  assert.match(Buffer.from(bundle.body).toString('utf8'), /^\/\/ Version 1\.51\.4 force-graph/);

  const licence = await fake.call('GET', '/vendor/LICENSE-3d-force-graph.txt');
  assert.equal(licence.status, 200);
  assert.equal(licence.headers['content-type'], 'text/plain; charset=utf-8');

  const missing = await fake.call('GET', '/vendor/nope.js');
  assert.equal(missing.status, 404);
  assert.equal(missing.body, 'not found');

  // A literal ".." is normalised away by URL parsing before the route ever sees
  // it (so it lands on the page 404); a percent-encoded one survives to the
  // route, where the prefix check refuses it.
  assert.equal((await fake.call('GET', '/vendor/../package.json')).status, 404);
  const encoded = await fake.call('GET', '/vendor/%2e%2e/package.json');
  assert.equal(encoded.status, 404);
  assert.equal(encoded.body, 'not found');

  // /vendor with no trailing name is a 404, not a listing
  assert.equal((await fake.call('GET', '/vendor')).status, 404);

  const tools = await fake.call('GET', '/api/tools');
  assert.equal(tools.status, 200);
  assert.deepEqual(JSON.parse(tools.body), TOOL_LIST_RESULT);

  const nope = await fake.call('GET', '/nope');
  assert.equal(nope.status, 404);
});

test('serveHttp: /i18n/<lang>.json is served, and every escape from it is a 404', async () => {
  const fake = fakeHttp();
  await serveHttp({
    http: fake.module, port: 0,
    deps: { ...makeDeps(), vendorDir: VENDOR_DIR, i18nDir: I18N_DIR },
    html: '<!doctype html><title>page</title>',
  });

  const ko = await fake.call('GET', '/i18n/ko.json');
  assert.equal(ko.status, 200);
  assert.equal(ko.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(typeof JSON.parse(Buffer.from(ko.body).toString('utf8'))['tab.overview'], 'string');

  // A literal ".." is normalised away by URL parsing before the route sees it
  // (so it lands on the page's own 404); a percent-encoded one survives to the
  // route, where the prefix check refuses it.
  assert.equal((await fake.call('GET', '/i18n/../package.json')).status, 404);
  const encoded = await fake.call('GET', '/i18n/%2e%2e/package.json');
  assert.equal(encoded.status, 404);
  assert.equal(encoded.body, 'not found');
  assert.equal((await fake.call('GET', '/i18n')).status, 404);
  assert.equal((await fake.call('GET', '/i18n/en.json')).status, 404, 'English is compiled into the page, not served');
});

test('serveHttp binding port 0 resolves with the port the SOCKET got, not the 0 that was asked for', async () => {
  // `--port 0` asks the kernel for a free port. The loop used to resolve with the
  // number it was handed, so `cascade view --port 0` printed
  // `http://127.0.0.1:0/` and nobody could open it. This is the one test here
  // that really binds a socket, because `address()` is the thing under test.
  const nodeHttp = (await import('node:http')).default;
  const { server, port } = await serveHttp({
    http: nodeHttp, port: 0, deps: makeDeps(), html: '<!doctype html><title>page</title>',
  });
  try {
    assert.notEqual(port, 0, 'the resolved port must be the bound one');
    assert.equal(port, server.address().port);
    // ...and the URL a command prints out of it is one that opens.
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<title>page<\/title>/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('serveHttp with no i18nDir: the route is simply absent, and the page still loads', async () => {
  const fake = fakeHttp();
  await serveHttp({ http: fake.module, port: 0, deps: makeDeps(), html: '<!doctype html><title>page</title>' });
  assert.equal((await fake.call('GET', '/i18n/ko.json')).status, 404);
  assert.equal((await fake.call('GET', '/')).status, 200);
});
