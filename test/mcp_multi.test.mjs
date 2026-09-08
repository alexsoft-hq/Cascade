import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildGraphFromSql } from '../src/adapters/sql_bridge.mjs';
import { projectPack, loadPack } from '../src/core/pack.mjs';
import { registryPath } from '../src/core/paths.mjs';
import { readRegistry, upsertProject, writeRegistryAtomic } from '../src/core/registry.mjs';
import { createProjectHost } from '../src/mcp/projects.mjs';
import { toolList } from '../src/mcp/catalog.mjs';
import { handleRpc } from '../src/mcp/stdio.mjs';
import { handleApi } from '../src/mcp/http.mjs';
import { computeTrust } from '../src/core/trust.mjs';

// M8 end to end (SPEC §13 MUST, §15 M8, §17.6): THREE real projects, each with
// its own tiny pack on disk and its own entry in a throwaway registry, served by
// ONE host through BOTH transports. Nothing here is stubbed except the clock:
// the packs are built by the real pack builder, read by the real loader, and
// answered by the real tool catalog.

const ENGINE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const CLI = path.join(ENGINE_ROOT, 'bin', 'cascade.mjs');

// ---------------------------------------------------------------------------
// Three projects, three schemas — each one answers a question the others cannot
// ---------------------------------------------------------------------------

const PROJECTS = [
  { id: 'alpha', table: 'alpha_order', column: 'total' },
  { id: 'beta', table: 'beta_invoice', column: 'amount' },
  { id: 'gamma', table: 'gamma_ticket', column: 'price' },
];

function packFor(p) {
  const catalog = [
    { kind: 'table', schema: null, table: p.table, comment: `${p.id} table` },
    { kind: 'column', schema: null, table: p.table, column: 'id', type: 'INT', comment: 'primary key' },
    { kind: 'column', schema: null, table: p.table, column: p.column, type: 'DECIMAL(10,2)', comment: `${p.id} money column` },
  ];
  const lineage = [{
    kind: 'lineage', namespace: `${p.id}Mapper`, id: 'selectByPrimaryKey', type: 'select',
    tables: [{ table: p.table, access: 'read' }],
    columns: [{ table: p.table, column: 'id', access: 'read' }, { table: p.table, column: p.column, access: 'read' }],
    file: `${p.id}Mapper.xml`, line: 30,
  }];
  const graph = buildGraphFromSql(catalog, lineage);
  return projectPack(graph, { project: p.id, builtAt: '2026-09-04T00:00:00.000Z', lanes: ['sql'] });
}

/** Three projects on disk + a registry that points at them. Returns a teardown-able root. */
function makeWorkspace(t) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-multi-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const env = { ...process.env, CASCADE_HOME: path.join(work, 'home'), XDG_CACHE_HOME: path.join(work, 'cache') };
  const regFile = registryPath(env);
  const sizes = {};
  for (const p of PROJECTS) {
    const dot = path.join(work, p.id, '.cascade');
    fs.mkdirSync(path.join(dot, 'pack'), { recursive: true });
    const file = path.join(dot, 'pack', 'pack.json');
    fs.writeFileSync(file, JSON.stringify(packFor(p)), 'utf8');
    sizes[p.id] = fs.statSync(file).size;
    writeRegistryAtomic(regFile, upsertProject(readRegistry(regFile), {
      id: p.id, dotCascadePath: dot, source: 'analyze', stack: ['sql'], lastCertifiedAt: '2026-09-04T00:00:00.000Z',
    }));
  }
  return { work, env, regFile, sizes };
}

/** The loader the server uses: the same shape bin/cascade.mjs builds. */
function loadProject(entry) {
  const file = path.join(entry.packDir ?? path.join(entry.dotCascadePath, 'pack'), 'pack.json');
  const pack = JSON.parse(fs.readFileSync(file, 'utf8'));
  const graph = loadPack(pack, { verifyDigest: true });
  return {
    graph,
    basis: { project: pack.meta.project, buildDigest: pack.digest, builtAt: pack.meta.builtAt, freshness: { verdict: 'unknown' } },
    trust: computeTrust({}),
    limits: [],
    pack: { project: pack.meta.project, digest: pack.digest, builtAt: pack.meta.builtAt, lanes: pack.meta.lanes, base: null, ddl: null, axes: null, laneStats: null },
  };
}

function hostFor(ws, opts = {}) {
  const logged = [];
  const host = createProjectHost({
    registry: readRegistry(ws.regFile),
    loadProject,
    budgetBytes: opts.budgetBytes,
    log: (line) => logged.push(line),
  });
  return { host, logged };
}

const rpc = (host, method, params, id = 1) => handleRpc({ jsonrpc: '2.0', id, method, params }, {
  toolList, callTool: (name, args) => host.callTool(name, args),
});
const post = (host, name, args) => handleApi('POST', '/api/call', { name, arguments: args }, {
  toolList, callTool: (n, a) => host.callTool(n, a),
});

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

test('three projects, one server: each `project` gets ITS OWN pack answered', (t) => {
  const ws = makeWorkspace(t);
  const { host } = hostFor(ws);
  for (const p of PROJECTS) {
    const resp = host.callTool('column_impact', { project: p.id, column: `${p.table}.${p.column}` });
    assert.equal(resp.basis.project, p.id);
    assert.equal(resp.answer.column, `${p.table}.${p.column}`);
    assert.equal(resp.answer.statements.length, 1);
    assert.match(resp.answer.statements[0].id, new RegExp(`^${p.id}Mapper`));
  }
  // …and a column that belongs to another project is NOT found in this one.
  assert.throws(() => host.callTool('column_impact', { project: 'alpha', column: 'beta_invoice.amount' }), (e) => {
    assert.equal(e.code, 'unknown-column');
    return true;
  });
});

test('a call with no `project` on a three-project server is `ambiguous` — never a silent pick', (t) => {
  const ws = makeWorkspace(t);
  const { host } = hostFor(ws);
  assert.throws(() => host.callTool('overview', {}), (e) => {
    assert.equal(e.code, 'ambiguous');
    assert.equal(e.message, 'several projects are registered: alpha, beta, gamma. Pass "project"');
    return true;
  });
  // Over stdio it is an isError result carrying the code (not a JSON-RPC error).
  const out = rpc(host, 'tools/call', { name: 'overview', arguments: {} });
  assert.equal(out.result.isError, true);
  assert.match(out.result.content[0].text, /^error \[ambiguous]: several projects are registered: alpha, beta, gamma/);
  // Over HTTP it is a 409 with structured JSON — never HTML (§17.4).
  const http = post(host, 'overview', {});
  assert.equal(http.status, 409);
  assert.deepEqual(http.json, { error: { code: 'ambiguous', message: 'several projects are registered: alpha, beta, gamma. Pass "project"' } });
});

test('an unknown project id is 404 unknown-key over HTTP and names the served ids', (t) => {
  const ws = makeWorkspace(t);
  const { host } = hostFor(ws);
  const http = post(host, 'overview', { project: 'delta' });
  assert.equal(http.status, 404);
  assert.equal(http.json.error.code, 'unknown-key');
  assert.equal(http.json.error.message, 'unknown project "delta": served ids are alpha, beta, gamma');
});

test('a pack too big for the budget is 503 pack-unreadable over HTTP, with the numbers in it', (t) => {
  const ws = makeWorkspace(t);
  const { host } = hostFor(ws, { budgetBytes: 100 }); // smaller than any of the three packs
  const http = post(host, 'overview', { project: 'alpha' });
  assert.equal(http.status, 503);
  assert.equal(http.json.error.code, 'pack-unreadable');
  assert.match(http.json.error.message, /^pack of alpha \(\d+\) exceeds the memory budget \(100\)/);
});

// ---------------------------------------------------------------------------
// Lazy + LRU, on real packs
// ---------------------------------------------------------------------------

test('`projects` lists three, loads none, and its loaded count follows the cache', (t) => {
  const ws = makeWorkspace(t);
  const { host } = hostFor(ws);
  const before = host.callTool('projects', {});
  assert.deepEqual(before.answer.projects.map((p) => p.id), ['alpha', 'beta', 'gamma']);
  assert.deepEqual(before.answer.projects.map((p) => p.loaded), [false, false, false], 'listing loads nothing');
  assert.equal(before.answer.cache.loaded, 0);
  assert.deepEqual(before.answer.projects.map((p) => p.stack), [['sql'], ['sql'], ['sql']]);

  host.callTool('overview', { project: 'beta' });
  const after = host.callTool('projects', {});
  assert.deepEqual(after.answer.projects.map((p) => [p.id, p.loaded]), [['alpha', false], ['beta', true], ['gamma', false]]);
  assert.equal(after.answer.cache.loaded, 1);
  assert.equal(after.answer.projects.find((p) => p.id === 'beta').bytes, ws.sizes.beta,
    'the byte proxy is the pack file on disk (no fact index in this fixture)');
  assert.equal(after.answer.cache.bytes, ws.sizes.beta);
});

test('a budget sized for TWO packs holds two and evicts the third — and re-loading gives the SAME bytes', (t) => {
  const ws = makeWorkspace(t);
  // Room for exactly two of the three packs.
  const budget = ws.sizes.alpha + ws.sizes.beta;
  const { host, logged } = hostFor(ws, { budgetBytes: budget });

  const alphaFirst = JSON.stringify(host.callTool('column_impact', { project: 'alpha', column: 'alpha_order.total' }));
  host.callTool('column_impact', { project: 'beta', column: 'beta_invoice.amount' });
  let stats = host.stats();
  assert.equal(stats.loaded, 2, 'two packs fit');
  assert.equal(stats.evictions, 0);
  assert.ok(stats.bytes <= budget);

  // The third does not fit. Eviction is least-recently-used and it keeps going
  // until the total fits: alpha goes first, and beta follows because gamma is
  // slightly larger than alpha, so beta+gamma still exceeds the budget.
  host.callTool('column_impact', { project: 'gamma', column: 'gamma_ticket.price' });
  stats = host.stats();
  assert.equal(stats.loaded, 1);
  assert.equal(stats.evictions, 2);
  assert.ok(stats.bytes <= budget, `held ${stats.bytes} bytes must stay within the ${budget} byte budget`);
  assert.equal(logged.length, 2, 'one log line per eviction');
  assert.match(logged[0], /^cascade: evicted project alpha \(\d+ bytes, last used /);
  assert.match(logged[1], /^cascade: evicted project beta \(\d+ bytes, last used /);
  assert.deepEqual(host.list().map((p) => [p.id, p.loaded]), [['alpha', false], ['beta', false], ['gamma', true]]);

  // Evicted and asked again: the answer is byte-identical to the first one.
  const alphaAgain = JSON.stringify(host.callTool('column_impact', { project: 'alpha', column: 'alpha_order.total' }));
  assert.equal(alphaAgain, alphaFirst, 'an evicted project must come back answering exactly as before');
  assert.equal(host.stats().misses, 4, 'alpha was loaded twice: 3 first-loads + 1 re-load');
});

// ---------------------------------------------------------------------------
// §13: the two transports say the same thing, to the byte
// ---------------------------------------------------------------------------

test('stdio and HTTP return byte-identical answers for the same call, per project', (t) => {
  const ws = makeWorkspace(t);
  const { host } = hostFor(ws);
  for (const p of PROJECTS) {
    for (const [name, args] of [
      ['overview', { project: p.id }],
      ['column_impact', { project: p.id, column: `${p.table}.${p.column}` }],
      ['table_usage', { project: p.id, table: p.table }],
      ['search', { project: p.id, query: p.id }],
    ]) {
      const overStdio = rpc(host, 'tools/call', { name, arguments: args }).result.content[0].text;
      const overHttp = JSON.stringify(post(host, name, args).json);
      assert.equal(overStdio, overHttp, `${name} on ${p.id} must be identical on both transports`);
    }
  }
});

test('the `project` routing argument reaches the same place from a query string, a body field or the arguments', (t) => {
  const ws = makeWorkspace(t);
  const { host } = hostFor(ws);
  const deps = { toolList, callTool: (n, a) => host.callTool(n, a) };
  const inArgs = handleApi('POST', '/api/call', { name: 'overview', arguments: { project: 'beta' } }, deps);
  const inBody = handleApi('POST', '/api/call', { name: 'overview', project: 'beta', arguments: {} }, deps);
  assert.equal(inArgs.status, 200);
  assert.equal(JSON.stringify(inArgs.json), JSON.stringify(inBody.json));
  // GET /api/projects goes through the same dispatcher as the stdio tool.
  const listed = handleApi('GET', '/api/projects', null, deps, new URLSearchParams());
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.json.answer.projects.map((p) => p.id), ['alpha', 'beta', 'gamma']);
  assert.equal(JSON.stringify(listed.json), rpc(host, 'tools/call', { name: 'projects', arguments: {} }).result.content[0].text);
  // …and a GET query parameter routes a per-project endpoint.
  const meta = handleApi('GET', '/api/meta', null, {
    ...deps, meta: (project) => ({ project }),
  }, new URLSearchParams({ project: 'gamma' }));
  assert.deepEqual(meta.json, { project: 'gamma' });
});

test('tools/list publishes the `project` argument on every project-scoped tool, and not on `projects`', () => {
  const list = toolList();
  for (const t of list.tools) {
    if (t.name === 'projects') {
      assert.equal('project' in (t.inputSchema.properties ?? {}), false, '`projects` IS the list of projects');
      continue;
    }
    assert.equal(t.inputSchema.properties.project.type, 'string', `${t.name} must publish a project argument`);
    assert.match(t.inputSchema.properties.project.description, /required when more than one project is served/);
  }
});

// ---------------------------------------------------------------------------
// The CLI wiring: `cascade mcp` really does serve the registry
// ---------------------------------------------------------------------------

/** Drive `cascade mcp` over its own stdin/stdout with line-delimited JSON-RPC. */
function driveCli(env, args, requests) {
  const input = requests.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const r = spawnSync(process.execPath, [CLI, 'mcp', ...args], { input, encoding: 'utf8', env, maxBuffer: 1 << 26 });
  return {
    ...r,
    lines: r.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l)),
  };
}

test('`cascade mcp` with no flags serves every registered project, and refuses to guess', (t) => {
  const ws = makeWorkspace(t);
  const out = driveCli(ws.env, [], [
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'projects', arguments: {} } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'overview', arguments: {} } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'column_impact', arguments: { project: 'gamma', column: 'gamma_ticket.price' } } },
  ]);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stderr, /^cascade mcp: serving 3 project\(s\) \[alpha, beta, gamma]/m);
  assert.match(out.stderr, /budget 512 MB of pack JSON/);

  const listed = JSON.parse(out.lines[0].result.content[0].text);
  assert.deepEqual(listed.answer.projects.map((p) => p.id), ['alpha', 'beta', 'gamma']);
  assert.deepEqual(listed.answer.projects.map((p) => p.loaded), [false, false, false], 'listing the registry loads no pack');

  assert.equal(out.lines[1].result.isError, true);
  assert.match(out.lines[1].result.content[0].text, /^error \[ambiguous]: several projects are registered: alpha, beta, gamma. Pass "project"$/);

  const answered = JSON.parse(out.lines[2].result.content[0].text);
  assert.equal(answered.basis.project, 'gamma');
  assert.equal(answered.answer.statements.length, 1);
});

test('`cascade mcp --project alpha --project beta` serves those two only', (t) => {
  const ws = makeWorkspace(t);
  const out = driveCli(ws.env, ['--project', 'alpha', '--project', 'beta'], [
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'projects', arguments: {} } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'overview', arguments: { project: 'gamma' } } },
  ]);
  assert.equal(out.status, 0, out.stderr);
  const listed = JSON.parse(out.lines[0].result.content[0].text);
  assert.deepEqual(listed.answer.projects.map((p) => p.id), ['alpha', 'beta']);
  assert.equal(out.lines[1].result.isError, true);
  assert.match(out.lines[1].result.content[0].text, /error \[unknown-key]: unknown project "gamma": served ids are alpha, beta/);
});

test('`cascade mcp --pack <dir>` still serves ONE anonymous project, named from the pack meta', (t) => {
  const ws = makeWorkspace(t);
  const packDir = path.join(ws.work, 'beta', '.cascade', 'pack');
  const out = driveCli(ws.env, ['--pack', packDir], [
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'projects', arguments: {} } },
    // One project: no `project` argument needed, and no ambiguity.
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'column_impact', arguments: { column: 'beta_invoice.amount' } } },
  ]);
  assert.equal(out.status, 0, out.stderr);
  const listed = JSON.parse(out.lines[0].result.content[0].text);
  assert.deepEqual(listed.answer.projects.map((p) => p.id), ['beta']);
  assert.equal(listed.answer.projects[0].dotCascadePath, null, 'a --pack server has no .cascade/ behind it');
  const answered = JSON.parse(out.lines[1].result.content[0].text);
  assert.equal(answered.basis.project, 'beta');
  assert.equal(answered.answer.statements.length, 1);
});

test('`cascade mcp --pack <dir> --project x` is refused: the two ways to choose contradict', (t) => {
  const ws = makeWorkspace(t);
  const out = driveCli(ws.env, ['--pack', path.join(ws.work, 'beta', '.cascade', 'pack'), '--project', 'alpha'], []);
  assert.equal(out.status, 2);
  assert.match(out.stderr, /--pack\/--root serve ONE pack/);
});

test('`cascade mcp --memory-budget` is applied, and a nonsense value is refused', (t) => {
  const ws = makeWorkspace(t);
  const tiny = driveCli(ws.env, ['--memory-budget', '0.0001'], [ // ~104 bytes: smaller than any pack
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'overview', arguments: { project: 'alpha' } } },
  ]);
  assert.equal(tiny.status, 0, tiny.stderr);
  assert.equal(tiny.lines[0].result.isError, true);
  assert.match(tiny.lines[0].result.content[0].text, /error \[pack-unreadable]: pack of alpha \(\d+\) exceeds the memory budget \(104\)/);

  const bad = driveCli(ws.env, ['--memory-budget', 'lots'], []);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /--memory-budget must be a positive number of megabytes/);
});

test('the answer says which project ANSWERED — the registry id, with the pack\'s own name beside it', (t) => {
  const ws = makeWorkspace(t);
  // A pack whose meta carries a different name: an `analyze` run with no
  // --project stamps "project" into every pack it builds, so on a server that
  // holds several of them the pack's own name identifies nothing.
  const dot = path.join(ws.work, 'renamed', '.cascade');
  fs.mkdirSync(path.join(dot, 'pack'), { recursive: true });
  const pack = packFor({ id: 'delta', table: 'delta_row', column: 'value' });
  pack.meta.project = 'project';
  fs.writeFileSync(path.join(dot, 'pack', 'pack.json'), JSON.stringify(pack), 'utf8');
  writeRegistryAtomic(ws.regFile, upsertProject(readRegistry(ws.regFile), {
    id: 'renamed', dotCascadePath: dot, source: 'analyze', stack: ['sql'], lastCertifiedAt: null,
  }));

  const out = driveCli(ws.env, [], [
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'column_impact', arguments: { project: 'renamed', column: 'delta_row.value' } } },
  ]);
  assert.equal(out.status, 0, out.stderr);
  const answered = JSON.parse(out.lines[0].result.content[0].text);
  assert.equal(answered.basis.project, 'renamed', 'the basis names the id the client addressed');
  assert.equal(answered.basis.packProject, 'project', 'and does not hide the name the pack carries');
  assert.equal(answered.answer.statements.length, 1);
});

// ---------------------------------------------------------------------------
// Federation through the real CLI server (RM44)
// ---------------------------------------------------------------------------

// The three packs above serve no HTTP route at all, so nothing here can cross.
// That is worth pinning as it stands: a server whose projects do not talk to
// each other must answer exactly as it did before this existed.

test('projects with no route index are reported as such, and no answer claims a crossing', (t) => {
  const ws = makeWorkspace(t);
  const out = driveCli(ws.env, [], [
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'projects', arguments: {} } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'endpoint_impact', arguments: { project: 'alpha', column: 'alpha_order.total' } } },
  ]);
  assert.equal(out.status, 0, out.stderr);
  // These fixture packs are written by hand, with no `analyze` and therefore no
  // sidecar: every one of them is honestly reported as not federated.
  const listed = JSON.parse(out.lines[0].result.content[0].text).answer.projects;
  assert.deepEqual(listed.map((p) => [p.id, p.federation.index]), [['alpha', 'absent'], ['beta', 'absent'], ['gamma', 'absent']]);

  const impact = JSON.parse(out.lines[1].result.content[0].text);
  assert.deepEqual(impact.answer.federation, { crossed: [], unmatched: [], skipped: [
    { project: 'beta', reason: 'no-index' }, { project: 'gamma', reason: 'no-index' },
  ] });
  assert.equal(impact.basis.siblings, undefined, 'nothing was walked, so nothing is claimed');
  // ...and the projects that could not be asked are named with the remedy.
  const said = impact.limits.filter((l) => l.scope === 'federation').map((l) => l.reason);
  assert.equal(said.length, 2);
  for (const s of said) assert.match(s, /carries no route index.*Re-run `cascade analyze`/);
});

test('a federated answer is byte-identical on both transports too', (t) => {
  const ws = makeWorkspace(t);
  const { host } = hostFor(ws);
  for (const [name, args] of [
    ['flow', { project: 'alpha', direction: 'up', column: 'alpha_order.total' }],
    ['endpoint_impact', { project: 'alpha', column: 'alpha_order.total' }],
    ['projects', {}],
  ]) {
    const overStdio = rpc(host, 'tools/call', { name, arguments: args }).result.content[0].text;
    const overHttp = JSON.stringify(post(host, name, args).json);
    assert.equal(overStdio, overHttp, `${name} must be identical on both transports`);
  }
});
