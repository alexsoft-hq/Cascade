import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGraphFromSql } from '../src/adapters/sql_bridge.mjs';
import { projectPack, loadPack } from '../src/core/pack.mjs';
import { createProjectHost } from '../src/mcp/projects.mjs';
import { toolList } from '../src/mcp/catalog.mjs';
import { serveHttp } from '../src/mcp/http.mjs';
import { readSourceFor } from '../src/viewer/source.mjs';
import { computeTrust } from '../src/core/trust.mjs';

// M9 end to end (SPEC §5, §15 M9): the CENTRAL viewer over a real socket, with
// TWO real projects behind one server. What is under test is that the page is
// served, that the registry listing is lazy, that `project` decides which pack
// answers — and that a call which does not say is refused rather than guessed.
// Nothing is stubbed: real packs on disk, the real loader, the real catalog.

const ENGINE_ROOT = fileURLToPath(new URL('../', import.meta.url));

const PROJECTS = [
  { id: 'alpha', table: 'alpha_order', column: 'total' },
  { id: 'beta', table: 'beta_invoice', column: 'amount' },
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
  return projectPack(buildGraphFromSql(catalog, lineage), {
    project: p.id, builtAt: '2026-09-04T00:00:00.000Z', lanes: ['sql'],
    base: { commit: p.id === 'alpha' ? 'aaaaaaaaaaaa' : 'bbbbbbbbbbbb', repoPath: null },
  });
}

/** Two projects on disk, plus the registry entries a host takes. */
function makeWorkspace(t) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-viewer-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  return PROJECTS.map((p) => {
    const dot = path.join(work, p.id, '.cascade');
    fs.mkdirSync(path.join(dot, 'pack'), { recursive: true });
    fs.writeFileSync(path.join(dot, 'pack', 'pack.json'), JSON.stringify(packFor(p)), 'utf8');
    return { id: p.id, dotCascadePath: dot, source: 'analyze', stack: ['sql'], lastCertifiedAt: '2026-09-04T00:00:00.000Z' };
  });
}

/** The loader `cascade view` builds, cut down to what these assertions need. */
function loadProject(entry) {
  const dir = entry.packDir ?? path.join(entry.dotCascadePath, 'pack');
  const pack = JSON.parse(fs.readFileSync(path.join(dir, 'pack.json'), 'utf8'));
  const graph = loadPack(pack, { verifyDigest: true });
  return {
    graph,
    basis: { project: entry.id, buildDigest: pack.digest, builtAt: pack.meta.builtAt, freshness: { verdict: 'unknown' } },
    trust: computeTrust({}),
    limits: [],
    pack: {
      project: pack.meta.project, digest: pack.digest, builtAt: pack.meta.builtAt,
      lanes: pack.meta.lanes, base: pack.meta.base ?? null, ddl: null, axes: pack.meta.axes ?? null, laneStats: null,
    },
    packJson: pack,
    packDir: dir,
  };
}

/** The whole `cascade view` server, on a real ephemeral port. */
async function startViewer(t, entries) {
  const host = createProjectHost({ registry: entries, loadProject });
  const contextOf = (project) => {
    const { projectId } = host.resolveProjectArg(project ? { project } : {});
    return { projectId, ctx: host.ctxFor(projectId) };
  };
  const html = fs.readFileSync(path.join(ENGINE_ROOT, 'viewer', 'index.html'), 'utf8');
  const { server } = await serveHttp({
    http,
    port: 0,
    host: '127.0.0.1',
    html,
    deps: {
      toolList,
      callTool: (name, args) => host.callTool(name, args),
      vendorDir: path.join(ENGINE_ROOT, 'viewer', 'vendor'),
      i18nDir: path.join(ENGINE_ROOT, 'viewer', 'i18n'),
      meta: (project) => {
        const { projectId, ctx } = contextOf(project);
        const pack = ctx.packJson;
        return {
          project: ctx.basis.project, projectId, digest: pack.digest, lanes: pack.meta?.lanes ?? null,
          builtAt: ctx.basis.builtAt, freshness: ctx.basis.freshness, base: pack.meta?.base ?? null,
          canSource: !!(pack.meta?.base?.repoPath), projects: host.list().map((p) => p.id),
        };
      },
      source: (nodeId, project) => {
        const { projectId, ctx } = contextOf(project);
        const repoRoot = ctx.packJson.meta?.base?.repoPath ?? null;
        if (!repoRoot) {
          const e = new Error(`source preview not available for ${projectId} (its pack records no repository path)`);
          e.code = 'unknown-key';
          throw e;
        }
        return readSourceFor(ctx.graph, repoRoot, nodeId, { readFile: (f) => fs.readFileSync(f, 'utf8') });
      },
    },
  });
  const listening = server.address().port;
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${listening}`;
  return {
    host,
    port: listening,
    get: (p) => fetch(base + p),
    call: (name, args, project) => fetch(base + '/api/call', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(project ? { name, arguments: args, project } : { name, arguments: args }),
    }),
  };
}

test('the viewer serves its page, its bundles and its catalogues over a real socket', async (t) => {
  const v = await startViewer(t, makeWorkspace(t));

  const page = await v.get('/');
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<title>Cascade viewer<\/title>/);
  assert.match(html, /id="projsel"/, 'the page carries the project selector');
  assert.match(html, /id="langseg"/, 'the page carries the language toggle');

  const ko = await v.get('/i18n/ko.json');
  assert.equal(ko.status, 200);
  assert.equal(typeof (await ko.json())['tab.overview'], 'string');
});

test('GET /api/projects lists both projects without loading either, then shows meta for the one that answered', async (t) => {
  const v = await startViewer(t, makeWorkspace(t));

  const before = await (await v.get('/api/projects')).json();
  assert.deepEqual(before.answer.projects.map((p) => p.id), ['alpha', 'beta']);
  assert.deepEqual(before.answer.projects.map((p) => p.loaded), [false, false]);
  assert.deepEqual(before.answer.projects.map((p) => p.meta), [null, null]);
  assert.equal(before.answer.cache.loaded, 0, 'listing loads no pack');

  const ov = await v.call('overview', {}, 'alpha');
  assert.equal(ov.status, 200);

  const after = await (await v.get('/api/projects')).json();
  const [alpha, beta] = after.answer.projects;
  assert.equal(alpha.loaded, true);
  assert.equal(alpha.meta.digest.length > 0, true);
  assert.deepEqual(alpha.meta.lanes, ['sql']);
  assert.deepEqual(alpha.meta.freshness, { verdict: 'unknown' });
  assert.equal(beta.loaded, false);
  assert.equal(beta.meta, null);
});

test('the same tool answers DIFFERENTLY per project — and the answer names the project it came from', async (t) => {
  const v = await startViewer(t, makeWorkspace(t));

  const a = await (await v.call('overview', {}, 'alpha')).json();
  const b = await (await v.call('overview', {}, 'beta')).json();

  assert.equal(a.basis.project, 'alpha');
  assert.equal(b.basis.project, 'beta');
  assert.notEqual(a.basis.buildDigest, b.basis.buildDigest, 'two packs, two digests');

  const searchA = await (await v.call('search', { query: 'alpha_order' }, 'alpha')).json();
  const searchB = await (await v.call('search', { query: 'alpha_order' }, 'beta')).json();
  assert.deepEqual(searchA.answer.tables.map((x) => x.table), ['alpha_order']);
  assert.deepEqual(searchB.answer.tables, [], "beta's pack has never heard of alpha_order");

  // ...and the other way round, so this is not one project answering both.
  const backB = await (await v.call('search', { query: 'beta_invoice' }, 'beta')).json();
  assert.deepEqual(backB.answer.tables.map((x) => x.table), ['beta_invoice']);
});

test('a call that does not say which project is 409 ambiguous — never a silent pick', async (t) => {
  const v = await startViewer(t, makeWorkspace(t));

  const r = await v.call('overview', {});
  assert.equal(r.status, 409);
  const j = await r.json();
  assert.equal(j.error.code, 'ambiguous');
  assert.match(j.error.message, /alpha, beta/);

  // The listing itself is a SERVER-level answer and needs no project.
  assert.equal((await v.get('/api/projects')).status, 200);
});

test('an unknown project is 404 JSON on every route the page uses', async (t) => {
  const v = await startViewer(t, makeWorkspace(t));

  const call = await v.call('overview', {}, 'gamma');
  assert.equal(call.status, 404);
  assert.equal((await call.json()).error.code, 'unknown-key');

  const meta = await v.get('/api/meta?project=gamma');
  assert.equal(meta.status, 404);
  assert.equal((await meta.json()).error.code, 'unknown-key');

  const src = await v.get('/api/source?node=table:alpha_order&project=gamma');
  assert.equal(src.status, 404);
  assert.equal((await src.json()).error.code, 'unknown-key');
});

test('GET /api/meta?project=<id> describes THAT project; without one it is 409, as JSON the page can show', async (t) => {
  const v = await startViewer(t, makeWorkspace(t));

  const a = await (await v.get('/api/meta?project=alpha')).json();
  const b = await (await v.get('/api/meta?project=beta')).json();
  assert.equal(a.project, 'alpha');
  assert.equal(b.project, 'beta');
  assert.notEqual(a.digest, b.digest);
  assert.equal(a.base.commit, 'aaaaaaaaaaaa');
  assert.equal(b.base.commit, 'bbbbbbbbbbbb');

  const none = await v.get('/api/meta');
  assert.equal(none.status, 409);
  assert.equal((await none.json()).error.code, 'ambiguous');
});

test('GET /api/source routes to the named project, and says why a pack with no repo path has no preview', async (t) => {
  const v = await startViewer(t, makeWorkspace(t));
  // These fixture packs record no repoPath, so the honest answer is a
  // structured 404 naming the project — not a blank panel.
  const r = await v.get('/api/source?node=table:alpha_order&project=alpha');
  assert.equal(r.status, 404);
  const j = await r.json();
  assert.equal(j.error.code, 'unknown-key');
  assert.match(j.error.message, /alpha/);
});
